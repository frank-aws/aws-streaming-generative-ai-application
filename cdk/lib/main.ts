import {Construct} from "constructs";
import {Stream, StreamMode} from "aws-cdk-lib/aws-kinesis";
import {Aws, CfnOutput, CustomResource, Duration, RemovalPolicy, Stack, StackProps} from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import {AnyPrincipal, CfnServiceLinkedRole, PolicyStatement, Role, ServicePrincipal} from "aws-cdk-lib/aws-iam";
import {IAMClient, ListRolesCommand} from "@aws-sdk/client-iam";
import {Domain, EngineVersion} from "aws-cdk-lib/aws-opensearchservice";
import {BastionHostLinux, BlockDeviceVolume, EbsDeviceVolumeType, InterfaceVpcEndpoint, InterfaceVpcEndpointAwsService, MachineImage, Peer, Port, SecurityGroup, SubnetType, Vpc} from "aws-cdk-lib/aws-ec2";
import {join as pathJoin} from "path";
import {Code as LambdaCode, Function, Runtime as LambdaRuntime} from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import {RetentionDays} from "aws-cdk-lib/aws-logs";
import {Provider} from "aws-cdk-lib/custom-resources";
import {CfnApplication} from "aws-cdk-lib/aws-kinesisanalyticsv2";
import {Asset} from "aws-cdk-lib/aws-s3-assets";
import * as sm from "aws-cdk-lib/aws-secretsmanager";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";


export interface MainStackProps extends StackProps {
    openSearchDomainName: string;
    kinesisStreamName: string;
    flinkAppName: string;
    snowflakeConnection?: SnowflakeStackProps;
}

interface SnowflakeStackProps {
    snowflakeAccountUrl: string;
    snowflakeSecretName: string;
    snowflakeDatabase: string;
    snowflakeSchema: string;
    snowflakeTable: string;
    firehoseStreamName: string;
}

interface FlinkApplicationProperties {
    REGION: string;
    INPUT_STREAM_NAME: string;
    [key: string]: string;
}

export class MainStack extends Stack {

    constructor(scope: Construct, id: string, props: MainStackProps) {
        super(scope, id, props);

        // Create bucket to upload flink application
        const flinkAsset = new Asset(this, "FlinkAsset", {
            path: pathJoin(__dirname, "../../flink-async-bedrock/target/flink-async-bedrock-0.1.jar"),
        });

        // Create a Kinesis Data Stream
        const stream = new Stream(this, "KinesisStream", {
            streamMode: StreamMode.ON_DEMAND,
            streamName: props.kinesisStreamName,
            removalPolicy: RemovalPolicy.DESTROY
        });

        // Create IAM role for kinesis data analytics application
        const flinkRole = new Role(this, "FlinkRole", {
            assumedBy: new ServicePrincipal("kinesisanalytics.amazonaws.com"),
        });

        const bucketArnString = `arn:aws:s3:::${flinkAsset.s3BucketName}`;

        flinkRole.addToPolicy(new PolicyStatement({
            actions: [
                "s3:GetObject",
                "s3:GetObjectVersion"
            ],
            resources: [`${bucketArnString}/${flinkAsset.s3ObjectKey}`]
        }))

        flinkRole.addToPolicy(new PolicyStatement({
            actions: [
                "kinesis:DescribeStream",
                "kinesis:GetShardIterator",
                "kinesis:GetRecords",
                "kinesis:PutRecord",
                "kinesis:PutRecords",
                "kinesis:ListShards"
            ],
            resources: [`arn:aws:kinesis:${this.region}:${this.account}:stream/${props.kinesisStreamName}`]

        }))

        flinkRole.addToPolicy(new PolicyStatement({
            actions: [
                "bedrock:InvokeModel"
            ],
            resources: [`arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`]
        }))

        // Create the VPC where MFA and OpenSearch will reside
        const vpc = new Vpc(this, "StreamingVPC", {
            maxAzs: 2,
            vpcName: "StreamingVPC",
            
        });

        flinkRole.addToPolicy(new PolicyStatement({
            actions: [
                "ec2:DescribeVpcs",
                "ec2:DescribeSubnets",
                "ec2:DescribeSecurityGroups",
                "ec2:DescribeDhcpOptions",
                "ec2:DescribeNetworkInterfaces",
                "ec2:CreateNetworkInterface",
                "ec2:CreateNetworkInterfacePermission",
                "ec2:DeleteNetworkInterface"
            ],
            resources: ["*"]                          
        }))

        // Create security group for Flink application
        const flinkSecurityGroup = new SecurityGroup(this, "FlinkSecurityGroup", {
            vpc: vpc, allowAllOutbound: true, securityGroupName: "FlinkSecurityGroup",
        });

        const kinesisVpcEndpointSecurityGroup = new SecurityGroup(this, "KinesisVpcEndpointSecurityGroup", {
            vpc: vpc, allowAllOutbound: true, securityGroupName: "KinesisVpcEndpointSecurityGroup",
        });

        const kinesisVpcEndpoint = new InterfaceVpcEndpoint(this, "KinesisInterfaceEndpoint", {
            vpc: vpc,
            service: InterfaceVpcEndpointAwsService.KINESIS_STREAMS,
            subnets: {subnetType: SubnetType.PUBLIC},
            securityGroups: [kinesisVpcEndpointSecurityGroup]
        })

        const createOpenSearchResources = () => {
            // Create security group for Bastion Host
            const bastionSecurityGroup = new SecurityGroup(this, "BastionSecurityGroup", {
                vpc: vpc, allowAllOutbound: false, securityGroupName: "BastionSecurityGroup",
            });

            // Create security group for OpenSearch cluster
            const opensearchSecurityGroup = new SecurityGroup(this, "OpensearchSecurityGroup", {
                vpc: vpc, securityGroupName: "OpensearchSecurityGroup",
            });

            // Bastion host to access Opensearch Dashboards
            const bastionHost = new BastionHostLinux(this, "BastionHost", {
                vpc: vpc,
                securityGroup: bastionSecurityGroup,
                machineImage: MachineImage.latestAmazonLinux2023(),
                blockDevices: [{
                    deviceName: "/dev/xvda", volume: BlockDeviceVolume.ebs(10, {
                        encrypted: true,
                    }),
                },],
            });

            bastionSecurityGroup.addEgressRule(Peer.anyIpv4(), Port.tcp(443));
            opensearchSecurityGroup.addIngressRule(bastionSecurityGroup, Port.tcp(443));
            opensearchSecurityGroup.addIngressRule(flinkSecurityGroup, Port.tcp(443));


            const iamClient = new IAMClient();

            // Service-linked role that Amazon OpenSearch Service will use
            (async () => {
                const response = await iamClient.send(new ListRolesCommand({
                    PathPrefix: "/aws-service-role/opensearchservice.amazonaws.com/",
                }));

                // Only if the role for OpenSearch Service doesn"t exist, it will be created.
                if (response.Roles && response.Roles?.length == 0) {
                    new CfnServiceLinkedRole(this, "OpensearchServiceLinkedRole", {
                        awsServiceName: "es.amazonaws.com",
                    });
                }
            })();

            // OpenSearch domain
            const domain = new Domain(this, "Domain", {
                version: EngineVersion.OPENSEARCH_2_11,
                nodeToNodeEncryption: true,
                enforceHttps: true,
                domainName: props.openSearchDomainName,
                encryptionAtRest: {
                    enabled: true,
                },
                vpc: vpc,
                capacity: {
                    dataNodes: 2,
                    masterNodes: 0,
                    dataNodeInstanceType: 'r6g.large.search',
                    multiAzWithStandbyEnabled: false
                },
                ebs: {
                    volumeSize: 30, volumeType: EbsDeviceVolumeType.GP3, throughput: 125, iops: 3000
                },
                removalPolicy: RemovalPolicy.DESTROY,
                zoneAwareness: {
                    enabled: true,
                },
                securityGroups: [opensearchSecurityGroup],
                offPeakWindowEnabled: true
            });

            domain.addAccessPolicies(new PolicyStatement({
                principals: [new AnyPrincipal()], actions: ["es:ESHttp*"], resources: [domain.domainArn + "/*"],
            }));

            const domainEndpointOutput = new CfnOutput(this, "domainEndpoint", {
                value: domain.domainEndpoint
            })

            const regionOutput = new CfnOutput(this, "regionOutput", {
                value: Aws.REGION.toString()
            })

            const bastionHostIdOutput = new CfnOutput(this, "bastionHostIdOutput", {
                value: bastionHost.instanceId
            })

            const accessOpenSearchClusterOutput = new CfnOutput(this, "accessOpenSearchClusterOutput", {
                value:  `aws ssm start-session --target ${bastionHost.instanceId} --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters '{"portNumber":["443"],"localPortNumber":["8157"], "host":["${domain.domainEndpoint}"]}'`
            })
            return domain;
        }

        const createFirehoseStream = () => {
            const snowProps = props.snowflakeConnection!
            const secret = sm.Secret.fromSecretNameV2(this, 'SnowflakeSecret', snowProps.snowflakeSecretName);

            const bucket = new s3.Bucket(this, 'FirehoseBucket', {
                removalPolicy: RemovalPolicy.DESTROY,
                autoDeleteObjects: true
            });

            // CloudWatch Logs
            const firehoseLogGroup = new logs.LogGroup(this, 'FirehoseLogs', {
                retention: logs.RetentionDays.ONE_WEEK
            });
            const firehoseLogStream = new logs.LogStream(this, 'FirehoseLogsStream', {
                logGroup: firehoseLogGroup,
                removalPolicy: RemovalPolicy.DESTROY
            })

            // IAM role for Firehose delivery to S3 and Snowflake
            const firehoseRole = new iam.Role(this, 'FirehoseRole', {
                assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
            })
            bucket.grantReadWrite(firehoseRole)
            secret.grantRead(firehoseRole)
            firehoseLogGroup.grantWrite(firehoseRole)

            const hose = new firehose.CfnDeliveryStream(this, 'FirehoseDeliveryStream', {
                deliveryStreamType: 'DirectPut',
                deliveryStreamName: snowProps.firehoseStreamName,
                snowflakeDestinationConfiguration: {
                    secretsManagerConfiguration: {
                        secretArn: secret.secretArn,
                        enabled: true
                    },
                    s3Configuration: {
                        bucketArn: bucket.bucketArn,
                        roleArn: firehoseRole.roleArn
                    },
                    database: snowProps.snowflakeDatabase,
                    table: snowProps.snowflakeTable,
                    schema: snowProps.snowflakeSchema,
                    accountUrl: snowProps.snowflakeAccountUrl,
                    roleArn: firehoseRole.roleArn,
                    dataLoadingOption: 'JSON_MAPPING',
                    cloudWatchLoggingOptions: {
                        enabled: true,
                        logGroupName: firehoseLogGroup.logGroupName,
                        logStreamName: firehoseLogStream.logStreamName
                    }
                }
            });

            hose.node.addDependency(firehoseRole);
        }
        const flinkApplicationProperties: FlinkApplicationProperties = {
            "REGION": this.region,
            "INPUT_STREAM_NAME": props.kinesisStreamName
        }
        if (props.snowflakeConnection) {
            createFirehoseStream()
            flinkApplicationProperties["FIREHOSE_DELIVERY_STREAM"] = props.snowflakeConnection.firehoseStreamName;
            flinkRole.addToPolicy(
                new PolicyStatement({
                    actions: [
                        "firehose:PutRecord",
                        "firehose:PutRecordBatch"
                    ],
                    resources: [`arn:aws:firehose:${this.region}:${this.account}:deliverystream/${props.snowflakeConnection.firehoseStreamName}`]
                })
            );
        } else {
            const domain = createOpenSearchResources()
            flinkApplicationProperties["OPEN_SEARCH_ENDPOINT"] = `https://${domain.domainEndpoint}`;
            domain.grantReadWrite(flinkRole);
        }
        const flinkApplication = new CfnApplication(
            this,
            "FlinkApplication", {
                applicationConfiguration : {
                    applicationCodeConfiguration: {
                        codeContent: {
                            s3ContentLocation : {
                                bucketArn : bucketArnString,
                                fileKey : flinkAsset.s3ObjectKey
                            }
                        },
                        codeContentType: "ZIPFILE"
                    },
                    flinkApplicationConfiguration : {
                        checkpointConfiguration : {
                            configurationType: "CUSTOM",
                            checkpointingEnabled: true,
                            checkpointInterval: 60000,
                          }
                    },
                    environmentProperties : {
                        propertyGroups: [
                            {
                                propertyGroupId : "FlinkApplicationProperties",
                                propertyMap : flinkApplicationProperties
                            }
                        ]
                    },
                    vpcConfigurations : [
                        {
                            subnetIds: vpc.selectSubnets({
                                subnetType: SubnetType.PRIVATE_WITH_EGRESS,
                              }).subnetIds,
                            securityGroupIds: [flinkSecurityGroup.securityGroupId],
                          },
                    ]
                },
                applicationName : props.flinkAppName, 
                runtimeEnvironment : "FLINK-1_18",
                serviceExecutionRole : flinkRole.roleArn,
            }
        );

        flinkApplication.node.addDependency(flinkAsset);
        flinkApplication.node.addDependency(flinkRole);

        const startFlinkApplicationHandler = new Function(this, "startFlinkApplicationHandler", {
            runtime: LambdaRuntime.PYTHON_3_12,
            code: LambdaCode.fromAsset(pathJoin(__dirname, "../customResources/startFlinkApplication")),
            handler: "index.on_event",
            timeout: Duration.minutes(14),
            memorySize: 512
        })

        const startFlinkApplicationProvider = new Provider(this, "startFlinkApplicationProvider", {
            onEventHandler: startFlinkApplicationHandler,
            logRetention: RetentionDays.ONE_WEEK
        })

        startFlinkApplicationHandler.addToRolePolicy(new PolicyStatement({
            actions: [
                "kinesisanalytics:DescribeApplication",
                "kinesisanalytics:StartApplication",
                "kinesisanalytics:StopApplication",

            ],
            resources: [`arn:aws:kinesisanalytics:${this.region}:${this.account}:application/${props.flinkAppName}`]
        }))

        const startFlinkApplicationResource = new CustomResource(this, "startFlinkApplicationResource", {
            serviceToken: startFlinkApplicationProvider.serviceToken,
            properties: {
                AppName: props.flinkAppName,
            }
        })

        startFlinkApplicationResource.node.addDependency(flinkApplication);


    }
}

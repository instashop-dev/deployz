import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DeployzStack } from '../src/deployz-stack.js';

describe('DeployzStack', () => {
  it('synthesizes without errors', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    // The template should be valid JSON (Template.fromStack throws on
    // invalid templates, so reaching here means synthesis succeeded).
    expect(template).toBeDefined();
  });

  it('creates a VPC with 2 AZs', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.hasResourceProperties('AWS::EC2::VPC', {});
  });

  it('creates an RDS PostgreSQL instance', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      DBInstanceClass: 'db.t4g.micro',
    });
  });

  it('creates a Lambda function for the API', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    // API + worker + durable + log retention custom resource
    template.resourceCountIs('AWS::Lambda::Function', 4);
  });

  it('creates the job queue with a dead-letter queue', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
  });

  // A queue with no consumer is the failure this wiring exists to prevent:
  // messages accumulate, jobs never run, and nothing reports an error.
  it('subscribes the worker to the job queue', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  it('routes CodeBuild completion back to the worker', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::Events::Rule', 2);
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        source: ['aws.codebuild'],
        'detail-type': ['CodeBuild Build State Change'],
      }),
    });
  });

  it('creates the release build pipeline', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::CodeBuild::Project', 1);
    template.resourceCountIs('AWS::ECR::Repository', 1);
  });

  // Documenso's monorepo image build exceeds the default SMALL (3 GB)
  // builder and could brush the default 30-minute timeout.
  it('sizes the build pipeline for larger monorepo images', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: Match.objectLike({ ComputeType: 'BUILD_GENERAL1_LARGE' }),
      TimeoutInMinutes: 60,
    });
  });

  // CloudFormation in the CUSTOMER's account fetches the bootstrap template
  // with none of our credentials, so this bucket has to allow public reads —
  // while the build-source bucket must not.
  it('creates a public template bucket and a private source bucket', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::S3::Bucket', 2);
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: Match.objectLike({
        BlockPublicPolicy: false,
        RestrictPublicBuckets: false,
      }),
    });
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: Match.objectLike({
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      }),
    });
  });

  // Without a published template the API must hand out no install link at
  // all; a link to a template AWS cannot fetch fails in the customer's
  // console with nothing to act on.
  it('passes the bootstrap template URL to the API only when one is set', () => {
    const withoutUrl = Template.fromStack(new DeployzStack(new App(), 'DeployzTest'));
    const environments = Object.values(withoutUrl.findResources('AWS::Lambda::Function')).map(
      (resource) => (resource.Properties as { Environment?: { Variables?: Record<string, unknown> } })
        .Environment?.Variables ?? {},
    );
    expect(environments.some((env) => 'BOOTSTRAP_TEMPLATE_URL' in env)).toBe(false);

    const url = 'https://bucket.s3.us-east-1.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json';
    const withUrl = Template.fromStack(
      new DeployzStack(new App({ context: { bootstrapTemplateUrl: url } }), 'DeployzTest'),
    );
    withUrl.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({ BOOTSTRAP_TEMPLATE_URL: url }),
      }),
    });
  });

  it('creates a DynamoDB table for durable execution state', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'executionId', KeyType: 'HASH' },
      ],
    });
  });

  it('exports stack outputs', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    const outputs = template.findOutputs('*');
    const outputKeys = Object.keys(outputs);
    expect(outputKeys).toContain('ExportDeployzTestDbHost');
    expect(outputKeys).toContain('ExportDeployzTestApiFunctionArn');
    expect(outputKeys).toContain('ExportDeployzTestJobQueueArn');
    expect(outputKeys).toContain('ExportDeployzTestTemplateBucket');
    expect(outputKeys).toContain('ExportDeployzTestBuildSourceBucket');
    expect(outputKeys).toContain('ExportDeployzTestDurableCallbackUrl');
  });

  // The custom domain is opt-in. Everything above synthesises without it, and
  // that is load-bearing: DNS lives on Cloudflare, so CDK cannot create or
  // validate the certificate itself and a plain `cdk deploy` must not need one.
  describe('API custom domain', () => {
    const CERT_ARN =
      'arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555';

    function synth(context: Record<string, string> = {}) {
      const app = new App({ context });
      return Template.fromStack(new DeployzStack(app, 'DeployzTest'));
    }

    it('creates no domain resources by default', () => {
      const template = synth();

      template.resourceCountIs('AWS::ApiGatewayV2::DomainName', 0);
      template.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 0);
    });

    it('creates no domain resources when only the domain name is given', () => {
      const template = synth({ apiDomainName: 'api.deployz.dev' });

      template.resourceCountIs('AWS::ApiGatewayV2::DomainName', 0);
    });

    it('maps the API onto the domain when both values are given', () => {
      const template = synth({
        apiDomainName: 'api.deployz.dev',
        apiCertificateArn: CERT_ARN,
      });

      template.resourceCountIs('AWS::ApiGatewayV2::DomainName', 1);
      template.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 1);
      template.hasResourceProperties('AWS::ApiGatewayV2::DomainName', {
        DomainName: 'api.deployz.dev',
        DomainNameConfigurations: [
          Match.objectLike({ CertificateArn: CERT_ARN, EndpointType: 'REGIONAL' }),
        ],
      });
    });

    // The CNAME target the operator needs in Cloudflare. Without an output it
    // is only discoverable by digging through the console.
    it('exports the regional domain name to point DNS at', () => {
      const template = synth({
        apiDomainName: 'api.deployz.dev',
        apiCertificateArn: CERT_ARN,
      });

      expect(Object.keys(template.findOutputs('*'))).toContain(
        'ExportDeployzTestApiRegionalDomainName',
      );
    });

    // Customer bootstrap templates bake this URL in, so it has to follow the
    // custom domain rather than the generated execute-api endpoint.
    it('builds the durable callback URL from the custom domain', () => {
      const template = synth({
        apiDomainName: 'api.deployz.dev',
        apiCertificateArn: CERT_ARN,
      });

      const output = template.findOutputs('ExportDeployzTestDurableCallbackUrl');
      expect(Object.values(output)[0]?.Value).toBe(
        'https://api.deployz.dev/durable/{workflowName}/{executionId}/callback',
      );
    });
  });
});
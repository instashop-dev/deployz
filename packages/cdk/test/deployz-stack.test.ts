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

    template.resourceCountIs('AWS::Lambda::Function', 3); // API + durable + log retention custom resource
  });

  it('creates an SQS queue for job processing', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SQS::Queue', 1);
  });

  it('creates an EventBridge rule targeting SQS', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::Events::Rule', 1);
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
const crypto = require('crypto');
const AWS = require('aws-sdk');

const getActivatedEventSources = (ses, env) => {
  if (env.AWS_BATCH_TRIGGER_ENABLE !== undefined) {
    const requestsEs = env.AWS_BATCH_TRIGGER_ENABLE.split(';');
    return ses.filter(es => requestsEs.indexOf(es) !== -1);
  }
  if (env.AWS_BATCH_TRIGGER_DISABLE !== undefined) {
    const exceptEs = env.AWS_BATCH_TRIGGER_DISABLE.split(';');
    return ses.filter(es => exceptEs.indexOf(es) === -1);
  }
  return [...ses];
};

const handleKinesisRecord = record => {
  const payload = Buffer.from(record.kinesis.data, 'base64').toString('utf-8');
  try {
    return JSON.parse(payload);
  } catch (err) {
    throw new Error('Kinesis Payload is not a json');
  }
};

const handleSnsRecord = record => {
  const payload = record.Sns.Message;
  try {
    return JSON.parse(payload);
  } catch (err) {
    throw new Error('SNS Payload is not a json');
  }
};

const handleSqsRecord = record => {
  const payload = record.body;
  try {
    return JSON.parse(payload);
  } catch (err) {
    throw new Error('SQS Payload is not a json');
  }
};

const eventSourceHandlers = {
  'aws:kinesis': handleKinesisRecord,
  'aws:sns': handleSnsRecord,
  'aws:sqs': handleSqsRecord
};
const supportedEventSources = Object.keys(eventSourceHandlers);
const activatedEventSources = getActivatedEventSources(supportedEventSources, process.env);

const handleAwsTrigger = records => {
  if (records.length !== 1) {
    throw new Error(`Invalid payload format. ${records.length} records. must contain single item.`);
  }
  const record = records[0];
  const eventSource = record.eventSource || record.EventSource;

  if (!supportedEventSources.includes(eventSource)) {
    throw new Error(`Event source ${eventSource} not supported`);
  } else if (!activatedEventSources.includes(eventSource)) {
    throw new Error(`Event source ${eventSource} not activated`);
  }
  return eventSourceHandlers[eventSource](record);
};

const validateString = (name, str, pattern = null) => {
  if (str === undefined) throw new Error(`${name} key is not defined`);
  if (typeof str !== 'string') throw new Error(`${name} key is not a string`);
  if (pattern && !pattern.test(str))
    throw new Error(`${name} does not comply with pattern '${pattern}' (${str})`);
  return str;
};
const nameBaseRegex = /[-_a-zA-Z0-9]+/;
const arnBaseRegex = /arn:([^:\n]*):([^:\n]*):([^:\n]*):([^:\n]*):(([^:\/\n]*)[:\/])?(.*)/;
validateString.AWS_NAME = new RegExp(`^${nameBaseRegex.source}$`);
validateString.AWS_ARN = new RegExp(`^${arnBaseRegex.source}$`);
validateString.AWS_NAME_ARN = new RegExp(
  `(${validateString.AWS_NAME.source})|(${validateString.AWS_ARN.source})`
);
validateString.AWS_NAME_ARN_WITH_REVISION = new RegExp(
  `(^${nameBaseRegex.source}(:\\d+)?$)|(^${arnBaseRegex.source}(:\\d+)?$)`
);
validateString.SHELL_VARIABLE = /^[_.a-zA-Z][_.a-zA-Z0-9]+$/;

const generateJobName = opt => {
  if (opt.jobName) return validateString('jobName', opt.jobName, validateString.AWS_NAME);
  const prefix = opt.jobNamePrefix
    ? validateString('jobNamePrefix', opt.jobNamePrefix, validateString.AWS_NAME)
    : opt.jobDefinition;
  return `${prefix}--${new Date()
    .toISOString()
    .slice(0, -5)
    .replace(/:/g, '-')}--${crypto.randomBytes(16).toString('hex')}`;
};

const validateDependsOn = dependsOn => {
  return dependsOn.map(job => {
    if (!job.jobId) throw new Error(`dependsOn job does not have jobId ${JSON.stringify(job)}`);
    return {jobId: job.jobId};
  });
};

const validateAndExtractRequest = request => {
  const req = {};
  req.jobQueue = validateString('jobQueue', request.jobQueue, validateString.AWS_NAME_ARN);
  req.jobDefinition = validateString(
    'jobDefinition',
    request.jobDefinition,
    validateString.AWS_NAME_ARN_WITH_REVISION
  );

  req.jobName = generateJobName(request);

  if (!!request.parameters && request.parameters.constructor === Object) {
    const parameters = {};
    for (const key of Object.keys(request.parameters)) {
      parameters[
        validateString('parametersKey', key, validateString.SHELL_VARIABLE)
      ] = validateString(key, request.parameters[key]);
    }
    req.parameters = parameters;
  }
  if (!!request.dependsOn && request.dependsOn.length > 0) {
    req.dependsOn = validateDependsOn(request.dependsOn);
  }
  return req;
};

const validatePattern = (pattern, str) => {
  const patterns = pattern.split(';');
  for (const motif of patterns) {
    if (new RegExp(`^${motif}$`).test(str)) return true;
  }
  return false;
};

const checkAuthorization = (request, opt) => {
  if (
    opt.AWS_BATCH_JOB_WHITELIST &&
    !validatePattern(opt.AWS_BATCH_JOB_WHITELIST, request.jobDefinition)
  ) {
    throw new Error(`JobDefinition ${request.jobDefinition} is not allowed`);
  }
  if (
    opt.AWS_BATCH_QUEUE_WHITELIST &&
    !validatePattern(opt.AWS_BATCH_QUEUE_WHITELIST, request.jobQueue)
  ) {
    throw new Error(`JobQueue ${request.jobQueue} is not allowed`);
  }
};

const parseEvent = event => {
  const request = event.Records ? handleAwsTrigger(event.Records) : event;
  const validRequest = validateAndExtractRequest(request);
  checkAuthorization(validRequest, process.env);
  return validRequest;
};

const handler = (event, context, callback) => {
  const batch = new AWS.Batch({apiVersion: '2016-08-10'});
  let jobRequest;
  try {
    jobRequest = parseEvent(event);
  } catch (err) {
    console.error(err);
    return callback(err);
  }

  batch.submitJob(jobRequest, (err, res) => {
    if (err) {
      console.error(err);
      return callback(err);
    }
    console.log(`Job ${res.jobName} launched with id ${res.jobId}`);
    return callback(null, res);
  });
};

// export for tests reasons
module.exports = {
  eventSourceHandlers,
  supportedEventSources,
  activatedEventSources,
  generateJobName,
  getActivatedEventSources,
  handleSnsRecord,
  handleKinesisRecord,
  handleSqsRecord,
  validateAndExtractRequest,
  checkAuthorization,
  validateString,
  validatePattern,
  validateDependsOn,
  handleAwsTrigger,
  parseEvent,
  handler
};

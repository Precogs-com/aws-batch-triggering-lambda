const AWS = require('aws-sdk');
const crypto = require('crypto');

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

const parseEvent = event => {
  const request = event.Records ? handleAwsTrigger(event.Records) : event;
  return validateAndExtractRequest(request);
};

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

const validateAndExtractRequest = request => {
  const req = {};
  for (const key of ['jobDefinition', 'jobQueue']) {
    req[key] = validateString(key, request[key], validateString.AWS_NAME);
  }
  req.jobName = generateJobName(request);

  if ((!!request.parameters) && (request.parameters.constructor === Object)) {
    const parameters = {}
    for (const key of Object.keys(request.parameters)) {
      parameters[validateString(key, key, validateString.SHELL_VARIABLE)] = validateString(key, request.parameters[key]);
    }
    req.parameters = parameters;
  }
  return req;
};

const validateString = (name, str, pattern = null) => {
  if (str === undefined) throw new Error(`${name} key is not defined`);
  if (typeof str !== 'string') throw new Error(`${name} key is not a string`);
  if (pattern && !pattern.test(str)) throw new Error(`${name} does not comply with pattern '${pattern}'`);
  return str;
};
validateString.AWS_NAME = /^[-_a-zA-Z0-9]+$/;
validateString.SHELL_VARIABLE = /^[_.a-zA-Z][_.a-zA-Z0-9]+$/;

const generateJobName = opt => {
  if (opt.jobName) return validateString('jobName', opt.jobName, validateString.AWS_NAME);
  const prefix = opt.jobNamePrefix ? validateString('jobNamePrefix', opt.jobNamePrefix, validateString.AWS_NAME)
    : opt.jobDefinition;
  return `${prefix}--${
    new Date().toISOString().slice(0,-5).replace(/:/g,'-')
  }--${crypto.randomBytes(16).toString('hex')}`;
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

const eventSourceHandlers = {
  'aws:kinesis': handleKinesisRecord,
  'aws:sns': handleSnsRecord
};
const supportedEventSources = Object.keys(eventSourceHandlers);
const activatedEventSources = getActivatedEventSources(supportedEventSources, process.env);

// export for tests reasons
module.exports = {
  eventSourceHandlers,
  supportedEventSources,
  activatedEventSources,
  generateJobName,
  getActivatedEventSources,
  handleSnsRecord,
  handleKinesisRecord,
  validateAndExtractRequest,
  validateString,
  handleAwsTrigger,
  parseEvent,
  handler
};

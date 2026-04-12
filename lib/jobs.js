const fs = require('fs');
const path = require('path');
const DIR = '/tmp/decode-jobs';

if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

function setJob(jobId, data) {
  fs.writeFileSync(path.join(DIR, jobId + '.json'), JSON.stringify(data));
}

function getJob(jobId) {
  const file = path.join(DIR, jobId + '.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function deleteJob(jobId) {
  const file = path.join(DIR, jobId + '.json');
  try { fs.unlinkSync(file); } catch {}
}

module.exports = { setJob, getJob, deleteJob };

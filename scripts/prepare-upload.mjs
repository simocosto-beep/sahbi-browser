// Run locally where the ChatGPT attachment actually exists. Redirect output to a private file.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {inspectFile} from '../src/forms.js';
const paths=process.argv.slice(2);
if(!paths.length) throw new Error('Usage: node scripts/prepare-upload.mjs /mnt/data/file.pdf');
const attachments=[];
for(const name of paths) {
  const real=await fs.realpath(name);
  if(!path.isAbsolute(name))throw new Error('Absolute paths required');
  const stat=await fs.stat(real);if(!stat.isFile()||stat.size>20*1024*1024)throw new Error('Invalid file size');
  const buffer=await fs.readFile(real);
  const meta=inspectFile(real,buffer);
  attachments.push({...meta,base64:buffer.toString('base64')});
}
process.stdout.write(JSON.stringify({attachments}));

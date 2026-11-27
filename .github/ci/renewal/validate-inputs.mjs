import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=path.resolve(process.argv[2]||'.');
const directory=path.join(root,'.github/ci/renewal');
const manifest=JSON.parse(fs.readFileSync(path.join(directory,'source-manifest.json'),'utf8'));
for(const {file,sha256} of manifest){
  assert.ok(!file.includes('..')&&!path.isAbsolute(file));
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex'),sha256,`source mismatch: ${file}`);
}
const input=JSON.parse(fs.readFileSync(path.join(directory,'inputs.json'),'utf8'));
if(process.argv[3]!=='source-only'){
  assert.equal(input.schema,'runvara-isolated-qualification/v1');
  assert.equal(input.platform,'linux/amd64');
  assert.equal(input.nodeMajor,22);
  assert.equal(input.playwrightVersion,'1.62.1');
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root,'.dockerignore'))).digest('hex'),input.dockerignoreSha256,'Docker context exclusion rules changed');
  assert.match(input.nodeBase||'',/^node@sha256:[a-f0-9]{64}$/,'HOLD: reviewed immutable Node base missing');
  assert.equal(input.nodeBase,'node@sha256:12f54cafa58d0e96554ae05871e29663ff7241836377dc9a7916449b8adb062c');
  assert.equal(input.nodeGlibcBase,'node@sha256:47725aca53d3295ec2d3be8f62726599b3033cc262edc2c7e429909b3ac599fc');
  assert.equal(input.nodeGlibcVersion,'22.23.5');
  assert.equal(fs.existsSync(path.join(root,'saas/server/Dockerfile.dockerignore')),input.dockerfileSpecificIgnoreSha256!==null);
  if(input.dockerfileSpecificIgnoreSha256!==null)assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root,'saas/server/Dockerfile.dockerignore'))).digest('hex'),input.dockerfileSpecificIgnoreSha256);
  assert.match(input.browserBase||'',/^mcr\.microsoft\.com\/playwright@sha256:[a-f0-9]{64}$/,'HOLD: reviewed immutable browser base missing');
  assert.ok(typeof input.imageReviewReference==='string'&&input.imageReviewReference.trim().length>=8,'HOLD: independent image review reference missing');
}
console.log(JSON.stringify({sourceFilesVerified:manifest.length,sourceOnly:process.argv[3]==='source-only'}));

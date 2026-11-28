import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import dns from 'node:dns/promises';
import {spawn} from 'node:child_process';
const interfaces=Object.entries(os.networkInterfaces()).flatMap(([name,rows])=>rows.map(row=>({name,internal:row.internal,address:row.address})));
assert.ok(interfaces.length&&interfaces.every(row=>row.internal),'network namespace has a non-loopback interface');
assert.match(fs.readFileSync('/proc/self/status','utf8'),/^NoNewPrivs:\s+1$/m);
assert.match(fs.readFileSync('/proc/self/status','utf8'),/^CapEff:\s+0+$/m);
for(const key of Object.keys(process.env))assert.ok(!/^(?:https?_proxy|all_proxy)$/i.test(key),'proxy environment not allowed');
for(const file of ['/var/run/docker.sock','/run/podman/podman.sock'])assert.ok(!fs.existsSync(file),'host engine socket present');
const listener=net.createServer(socket=>socket.end());
await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
await new Promise((resolve,reject)=>{const socket=net.connect(listener.address().port,'127.0.0.1');socket.once('connect',()=>{socket.end();resolve();});socket.once('error',reject);});
await new Promise(resolve=>listener.close(resolve));
// No JS transport preload is used for these negative OS-boundary checks.
for(const host of ['192.0.2.1','2001:db8::1'])await new Promise((resolve,reject)=>{
  const socket=net.connect({host,port:443});const timer=setTimeout(()=>{socket.destroy();reject(Error('network denial was not immediate/bounded'));},1500);
  socket.once('connect',()=>{clearTimeout(timer);socket.destroy();reject(Error('non-loopback transport connected'));});
  socket.once('error',error=>{clearTimeout(timer);socket.destroy();assert.ok(['ENETUNREACH','EHOSTUNREACH','EAFNOSUPPORT','EINVAL'].includes(error.code),`unexpected transport result: ${error.code}`);resolve();});
});
// Dedicated .invalid resolver query is bounded and cannot leave this namespace.
const resolver=new dns.Resolver({timeout:500,tries:1});resolver.setServers(['192.0.2.1']);
await assert.rejects(resolver.resolve4('runvara-egress-canary.invalid'));
if(process.argv[2]!=='child'){
  const child=spawn(process.execPath,[new URL(import.meta.url).pathname,'child'],{env:{PATH:process.env.PATH,HOME:'/tmp'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
  const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
  const code=await new Promise(resolve=>child.once('exit',resolve));clearTimeout(timer);
  assert.equal(code,0,'independent child network boundary failed');assert.ok(output.includes('networkBoundaryVerified'));
}
console.log(JSON.stringify({networkBoundaryVerified:true,child:process.argv[2]==='child'}));

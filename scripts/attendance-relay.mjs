// Run on the existing device relay host. No Supabase keys are required.
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const receiver = 'https://qdtgrddhpbwrutvojpes.supabase.co/functions/v1/iclock';
export function upstreamUrl(requestUrl) {
  const input = new URL(requestUrl, 'http://relay.local');
  const path = input.pathname.toLowerCase().replace(/\.aspx$/, '');
  if (!/^\/iclock\/(cdata|getrequest|devicecmd)$/.test(path)) return null;
  return `${receiver}${path}${input.search}`;
}

export function createAttendanceRelay(forward = fetch) {
  return http.createServer(async (request, response) => {
    const target = upstreamUrl(request.url);
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, {'Content-Type':'application/json'});
      response.end(JSON.stringify({status:'ok', project:'qdtgrddhpbwrutvojpes'}));
      return;
    }
    if (!target || !['GET','POST'].includes(request.method)) {
      response.writeHead(404); response.end('Not Found'); return;
    }
    try {
      const chunks=[];
      let size=0;
      for await (const chunk of request) {
        size+=chunk.length;
        if (size>2*1024*1024) {
          response.writeHead(413); response.end('Upload exceeds 2 MB.'); return;
        }
        chunks.push(chunk);
      }
      const result=await forward(target, {
        method:request.method,
        headers:{'Content-Type':request.headers['content-type'] || 'text/plain'},
        body:request.method==='POST' ? Buffer.concat(chunks) : undefined,
        signal:AbortSignal.timeout(25000),
      });
      const body=await result.text();
      response.writeHead(result.status, {'Content-Type':result.headers.get('content-type') || 'text/plain; charset=utf-8'});
      response.end(body);
    } catch {
      // Devices retry failed uploads. Never acknowledge a failed cloud write.
      response.writeHead(503, {'Content-Type':'text/plain'});
      response.end('Attendance storage unavailable; retry upload.');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port=Number(process.env.ATTENDANCE_PORT || 8081);
  const host=process.env.ATTENDANCE_HOST || '0.0.0.0';
  if (!Number.isInteger(port) || port<1 || port>65535) throw new Error('Invalid attendance port.');
  createAttendanceRelay().listen(port,host,()=>console.log(`Attendance relay listening on ${host}:${port}; destination project qdtgrddhpbwrutvojpes`));
}

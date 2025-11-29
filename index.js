const WebSocket = require('ws');
const net = require('net');
const http = require('http');

const PORT = process.env.PORT || 8080;
const TOKEN = process.env.TOKEN || '23cd62df-4bc6-4623-82a3-a90e8e9cd244';
const CF_FALLBACK_IPS = process.env.PRIP 
  ? process.env.PRIP.split(',') 
  : ['ProxyIP.JP.CMLiussss.net'];

const encoder = new TextEncoder();

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WebSocket Proxy Server');
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// 创建 WebSocket 服务器
const wss = new WebSocket.Server({ 
  server,
  verifyClient: (info) => {
    // 验证 token
    const protocol = info.req.headers['sec-websocket-protocol'];
    if (TOKEN && protocol !== TOKEN) {
      return false;
    }
    return true;
  }
});

wss.on('connection', (ws, req) => {
  // 如果有 token,设置协议
  if (TOKEN && req.headers['sec-websocket-protocol']) {
    ws.protocol = TOKEN;
  }

  handleSession(ws).catch(() => safeCloseWebSocket(ws));
});

async function handleSession(webSocket) {
  let remoteSocket = null;
  let isClosed = false;

  const cleanup = () => {
    if (isClosed) return;
    isClosed = true;
    
    if (remoteSocket) {
      try { remoteSocket.destroy(); } catch {}
      remoteSocket = null;
    }
    
    safeCloseWebSocket(webSocket);
  };

  const pumpRemoteToWebSocket = (socket) => {
    socket.on('data', (data) => {
      if (!isClosed && webSocket.readyState === WebSocket.OPEN) {
        try {
          webSocket.send(data);
        } catch (err) {
          cleanup();
        }
      }
    });

    socket.on('end', () => {
      if (!isClosed) {
        try { webSocket.send('CLOSE'); } catch {}
        cleanup();
      }
    });

    socket.on('error', () => {
      cleanup();
    });
  };

  const parseAddress = (addr) => {
    if (addr[0] === '[') {
      const end = addr.indexOf(']');
      return {
        host: addr.substring(1, end),
        port: parseInt(addr.substring(end + 2), 10)
      };
    }
    const sep = addr.lastIndexOf(':');
    return {
      host: addr.substring(0, sep),
      port: parseInt(addr.substring(sep + 1), 10)
    };
  };

  const isCFError = (err) => {
    const msg = err?.message?.toLowerCase() || '';
    return msg.includes('proxy request') || 
           msg.includes('cannot connect') || 
           msg.includes('econnrefused') ||
           msg.includes('etimedout');
  };

  const connectToRemote = async (targetAddr, firstFrameData) => {
    const { host, port } = parseAddress(targetAddr);
    const attempts = [null, ...CF_FALLBACK_IPS];

    for (let i = 0; i < attempts.length; i++) {
      try {
        const targetHost = attempts[i] || host;
        
        remoteSocket = net.connect({
          host: targetHost,
          port: port,
          timeout: 10000
        });

        await new Promise((resolve, reject) => {
          remoteSocket.once('connect', resolve);
          remoteSocket.once('error', reject);
        });

        // 发送首帧数据
        if (firstFrameData) {
          remoteSocket.write(firstFrameData);
        }

        webSocket.send('CONNECTED');
        pumpRemoteToWebSocket(remoteSocket);
        return;

      } catch (err) {
        // 清理失败的连接
        if (remoteSocket) {
          try { remoteSocket.destroy(); } catch {}
          remoteSocket = null;
        }

        // 如果不是连接错误或已是最后尝试,抛出错误
        if (!isCFError(err) || i === attempts.length - 1) {
          throw err;
        }
      }
    }
  };

  webSocket.on('message', async (data) => {
    if (isClosed) return;

    try {
      // WebSocket 的 data 可能是 Buffer 或 String
      const message = data.toString();

      if (message.startsWith('CONNECT:')) {
        const sep = message.indexOf('|', 8);
        await connectToRemote(
          message.substring(8, sep),
          message.substring(sep + 1)
        );
      }
      else if (message.startsWith('DATA:')) {
        if (remoteSocket && !remoteSocket.destroyed) {
          remoteSocket.write(message.substring(5));
        }
      }
      else if (message === 'CLOSE') {
        cleanup();
      }
      else if (data instanceof Buffer && remoteSocket && !remoteSocket.destroyed) {
        remoteSocket.write(data);
      }
    } catch (err) {
      try { webSocket.send('ERROR:' + err.message); } catch {}
      cleanup();
    }
  });

  webSocket.on('close', cleanup);
  webSocket.on('error', cleanup);
}

function safeCloseWebSocket(ws) {
  try {
    if (ws.readyState === WebSocket.OPEN || 
        ws.readyState === WebSocket.CLOSING) {
      ws.close(1000, 'Server closed');
    }
  } catch {}
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`WebSocket Proxy Server listening on port ${PORT}`);
  console.log(`Token authentication: ${TOKEN ? 'enabled' : 'disabled'}`);
});
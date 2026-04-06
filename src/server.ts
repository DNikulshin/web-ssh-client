import express, { Request, Response } from 'express';
import http from 'http';
import WebSocket from 'ws';
import { Client, ClientChannel } from 'ssh2';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

// 1. Логирование всех запросов (для диагностики)
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// 2. Явная обработка корневого маршрута
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, '../public/index.html');
  console.log(`Looking for index at: ${indexPath}`);
  res.sendFile(indexPath, (err) => {
    if (err) {
      console.error(`Error sending index.html: ${err.message}`);
      res.status(404).send('index.html not found. Check that public folder exists.');
    }
  });
});

// 3. Статические файлы (оставить как fallback)
app.use(express.static(path.join(__dirname, '../public')));

// Health check для Render
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Типы сообщений WebSocket
interface ConnectMessage {
  type: 'connect';
  data: {
    host: string;
    port: number | string;
    username: string;
    password?: string;
    privateKey?: string;
  };
}

interface InputMessage {
  type: 'input';
  data: string;
}

interface ResizeMessage {
  type: 'resize';
  data: { rows: number; cols: number };
}

interface DisconnectMessage {
  type: 'disconnect';
}

type WSMessage = ConnectMessage | InputMessage | ResizeMessage | DisconnectMessage;

wss.on('connection', (ws: WebSocket) => {
  const sessionId = uuidv4();
  let sshClient: Client | null = null;
  let sshStream: ClientChannel | null = null;

  console.log(`[${sessionId}] WebSocket connected`);

  const send = (type: string, data: any) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, data }));
    }
  };

  ws.on('message', (raw: string) => {
    let msg: WSMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // CONNECT
    if (msg.type === 'connect') {
      const { host, port, username, password, privateKey } = msg.data;
      const portNum = parseInt(port as string) || 22;

      sshClient = new Client();

      const config: any = {
        host,
        port: portNum,
        username,
        readyTimeout: 20000,
        keepaliveInterval: 10000,
      };

      if (privateKey) {
        config.privateKey = privateKey;
      } else {
        config.password = password;
      }

      sshClient.on('ready', () => {
        send('status', { connected: true, message: `Connected to ${host}` });

        sshClient!.shell({ term: 'xterm-256color', rows: 40, cols: 120 }, (err, stream) => {
          if (err) {
            send('error', { message: err.message });
            return;
          }

          sshStream = stream;

          stream.on('data', (data: Buffer) => {
            send('output', { text: data.toString('base64'), encoding: 'base64' });
          });

          stream.stderr.on('data', (data: Buffer) => {
            send('output', { text: data.toString('base64'), encoding: 'base64' });
          });

          stream.on('close', () => {
            send('status', { connected: false, message: 'Session closed' });
            sshClient?.end();
          });
        });
      });

      sshClient.on('error', (err: Error) => {
        send('error', { message: `SSH Error: ${err.message}` });
      });

      sshClient.on('close', () => {
        send('status', { connected: false, message: 'Connection closed' });
      });

      sshClient.connect(config);
    }

    // INPUT
    if (msg.type === 'input' && sshStream) {
      sshStream.write(msg.data);
    }

    // RESIZE
    if (msg.type === 'resize' && sshStream) {
      const { rows, cols } = msg.data;
      // ssh2 требует 4 аргумента: rows, cols, height, width
      sshStream.setWindow(rows, cols, rows, cols);
    }

    // DISCONNECT
    if (msg.type === 'disconnect') {
      if (sshClient) sshClient.end();
    }
  });

  ws.on('close', () => {
    console.log(`[${sessionId}] WebSocket disconnected`);
    if (sshClient) sshClient.end();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port http://localhost:${PORT}`);
});
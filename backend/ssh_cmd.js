const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.exec(process.argv[2] || 'docker ps', (err, stream) => {
    if (err) throw err;
    stream.on('close', (code, signal) => {
      conn.end();
    }).on('data', (data) => {
      process.stdout.write(data);
    }).stderr.on('data', (data) => {
      process.stderr.write(data);
    });
  });
}).on('keyboard-interactive', (name, instructions, instructionsLang, prompts, finish) => {
  finish(['Xchange4VPS@']);
}).on('error', (err) => {
  console.error('SSH Error:', err);
}).connect({
  host: '185.158.133.1',
  port: 65002,
  username: 'root',
  password: 'Xchange4VPS@',
  tryKeyboard: true,
  readyTimeout: 10000
});

const { startLocalPreview } = require('./server.cjs');

startLocalPreview().then(({ url }) => {
  process.stdout.write(`友方后台本机练习入口：${url}/login.html\n`);
  process.stdout.write('仅本机可访问；资料存于电脑本地，不写入友方云端。按 Ctrl+C 停止。\n');
}).catch(error => {
  process.stderr.write(`本机练习后台启动失败：${error.message}\n`);
  process.exitCode = 1;
});

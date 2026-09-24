// This file is served only by the loopback practice server, never by CloudBase hosting.
(function (global) {
  async function post(route, body) {
    const response = await fetch(route, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    if (!response.ok) throw new Error(`本机练习服务连接失败（${response.status}）。`);
    return response.json();
  }
  global.cloudbase = {
    init: function () {
      return {
        auth: () => ({ signInAnonymously: async () => ({}) }),
        callFunction: async ({ data }) => ({ result: await post('/__local/api', data) }),
        getTempFileURL: ({ fileList }) => post('/__local/media-urls', { fileList })
      };
    }
  };
}(window));

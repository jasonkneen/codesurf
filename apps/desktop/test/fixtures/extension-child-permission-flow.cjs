const { app, BrowserWindow, protocol, session } = require('electron')
const { join } = require('node:path')

protocol.registerSchemesAsPrivileged([{
  scheme: 'codesurf-ext',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
  },
}])

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const childHtml = `<!doctype html>
<html>
  <body>Extension permission probe</body>
</html>`

app.whenReady().then(async () => {
  const permissionSession = session.fromPartition('permission-extension-child')
  permissionSession.protocol.handle('codesurf-ext', request => {
    if (request.url !== 'codesurf-ext://permission-probe/index.html') {
      return new Response('Not found', { status: 404 })
    }
    return new Response(childHtml, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  })
  permissionSession.setPermissionCheckHandler(() => false)
  permissionSession.setPermissionRequestHandler(
    (_contents, permission, callback, details) => {
      write({
        kind: details.mediaTypes?.length === 0 ? 'display-preflight' : 'media-request',
        permission,
        isMainFrame: details.isMainFrame,
        mediaTypes: details.mediaTypes,
        requestingUrl: details.requestingUrl,
        securityOrigin: details.securityOrigin,
      })
      callback(permission === 'media' && details.mediaTypes?.length === 0)
    },
  )
  permissionSession.setDisplayMediaRequestHandler((request, callback) => {
    write({
      kind: 'display-request',
      frameUrl: request.frame?.url,
      frameOrigin: request.frame?.origin,
      parentUrl: request.frame?.parent?.url,
      topUrl: request.frame?.top?.url,
      securityOrigin: request.securityOrigin,
      userGesture: request.userGesture,
      videoRequested: request.videoRequested,
    })
    callback(request.frame ? { video: request.frame } : {})
  })

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: permissionSession,
    },
  })
  await window.loadFile(join(__dirname, 'extension-child-permission-flow.html'))
  const child = window.webContents.mainFrame.framesInSubtree.find(
    frame => frame.url === 'codesurf-ext://permission-probe/index.html',
  )
  if (!child) throw new Error('codesurf-ext child frame was not created')

  const mediaResult = await child.executeJavaScript(
    `navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      for (const track of stream.getTracks()) track.stop()
      return { granted: true }
    }, error => ({ granted: false, error: error.name }))`,
    true,
  )
  write({ kind: 'media-result', ...mediaResult })

  const displayResult = await child.executeJavaScript(
    `navigator.mediaDevices.getDisplayMedia({ audio: false, video: true }).then(stream => {
      const tracks = stream.getTracks().map(track => track.kind)
      for (const track of stream.getTracks()) track.stop()
      return { granted: true, tracks }
    }, error => ({ granted: false, error: error.name }))`,
    true,
  )
  write({ kind: 'display-result', ...displayResult })
  window.destroy()
  app.quit()
}).catch(error => {
  write({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
  app.exit(1)
})

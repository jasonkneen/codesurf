const { app, BrowserWindow, session } = require('electron')
const { join } = require('node:path')

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function createFixtureWindow(permissionSession) {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: permissionSession,
    },
  })
  await window.loadFile(join(__dirname, 'display-permission-flow.html'))
  return window
}

async function requestDisplay(window) {
  return await window.webContents.executeJavaScript(
    `navigator.mediaDevices.getDisplayMedia({ audio: false, video: true }).then(stream => {
      const kinds = stream.getTracks().map(track => track.kind)
      for (const track of stream.getTracks()) track.stop()
      return { granted: true, tracks: kinds }
    }, error => ({ granted: false, error: error.name }))`,
    true,
  )
}

app.whenReady().then(async () => {
  const deniedSession = session.fromPartition('permission-flow-denied')
  let deniedDisplayCalls = 0
  deniedSession.setPermissionCheckHandler(() => false)
  deniedSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    if (permission === 'media' && details.mediaTypes?.length === 0) {
      write({ kind: 'denied-preflight' })
    }
    callback(false)
  })
  deniedSession.setDisplayMediaRequestHandler((_request, callback) => {
    deniedDisplayCalls += 1
    callback({})
  })
  const deniedWindow = await createFixtureWindow(deniedSession)
  const deniedResult = await requestDisplay(deniedWindow)
  write({ kind: 'denied-result', displayCalls: deniedDisplayCalls, ...deniedResult })

  const allowedSession = session.fromPartition('permission-flow-allowed')
  allowedSession.setPermissionCheckHandler(() => false)
  allowedSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const displayPreflight = permission === 'media'
      && Array.isArray(details.mediaTypes)
      && details.mediaTypes.length === 0
    if (displayPreflight) {
      write({
        kind: 'preflight',
        mediaTypes: details.mediaTypes,
        securityOrigin: details.securityOrigin,
      })
    }
    callback(displayPreflight)
  })
  allowedSession.setDisplayMediaRequestHandler((request, callback) => {
    write({
      kind: 'display',
      securityOrigin: request.securityOrigin,
      userGesture: request.userGesture,
      videoRequested: request.videoRequested,
    })
    callback(request.frame ? { video: request.frame } : {})
  })

  const allowedWindow = await createFixtureWindow(allowedSession)
  const result = await requestDisplay(allowedWindow)
  write({ kind: 'result', ...result })
  deniedWindow.destroy()
  allowedWindow.destroy()
  app.quit()
}).catch(error => {
  write({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
  app.exit(1)
})

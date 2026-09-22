const { app } = require('electron')

app.setName('CodeSurf')

const locked = app.requestSingleInstanceLock()
process.stdout.write(`${JSON.stringify({ locked, pid: process.pid })}\n`)

if (!locked) {
  app.quit()
} else {
  const stop = () => {
    if (app.hasSingleInstanceLock()) app.releaseSingleInstanceLock()
    app.quit()
  }

  process.stdin.resume()
  process.stdin.once('end', stop)
  process.once('SIGTERM', stop)
}

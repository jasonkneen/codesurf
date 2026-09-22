const { MorphCloudClient } = require('morphcloud')

const BUS_CHANNEL = 'morph'
const INSTANCE_TAG = 'contex-extension'
const INSTANCE_TAG_VALUE = 'morph'
const DESKTOP_SERVICE = 'desktop'
const TEMPLATE_METADATA_KEYS = ['label', 'name', 'title', 'template', 'source']
const DEFAULT_DEVBOX_LABEL = 'Morph Devbox'

function parseArgs(args) {
  if (!args) return {}
  if (typeof args === 'string') {
    try { return JSON.parse(args) } catch { return {} }
  }
  return args
}

function shellEscape(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`
}

function emit(ctx, requestId, stage, message, extra = {}) {
  ctx.bus.publish(BUS_CHANNEL, 'data', {
    action: 'progress',
    requestId,
    stage,
    message,
    ...extra,
  })
}

function previewUrlFor(serviceUrl) {
  if (!serviceUrl) return ''
  const base = String(serviceUrl).replace(/\/$/, '')
  const params = new URLSearchParams({
    scale: 'true',
    scaleViewport: 'true',
    autoconnect: 'true',
  })
  return `${base}/vnc_lite.html?${params.toString()}`
}

function summarizeSnapshot(snapshot) {
  const metadata = snapshot.metadata || {}
  let label = snapshot.id
  for (const key of TEMPLATE_METADATA_KEYS) {
    if (metadata[key]) {
      label = String(metadata[key])
      break
    }
  }
  return {
    id: snapshot.id,
    kind: 'snapshot',
    label,
    created: snapshot.created,
    status: snapshot.status,
    imageId: snapshot.refs?.imageId,
    metadata,
  }
}

function summarizeImage(image) {
  return {
    id: image.id,
    kind: 'image',
    label: image.name || image.id,
    created: image.created,
    description: image.description || '',
    diskSize: image.diskSize,
  }
}

function summarizeInstance(instance) {
  const service = (instance.networking?.httpServices || []).find(s => s.name === DESKTOP_SERVICE)
  return {
    id: instance.id,
    status: instance.status,
    created: instance.created,
    snapshotId: instance.refs?.snapshotId,
    imageId: instance.refs?.imageId,
    metadata: instance.metadata || {},
    ttl: instance.ttl || {},
    httpServices: instance.networking?.httpServices || [],
    previewBaseUrl: service ? service.url : '',
    previewUrl: service ? previewUrlFor(service.url) : '',
  }
}

async function ensureDesktop(instance, password, startupCommand, ctx, requestId) {
  emit(ctx, requestId, 'desktop', 'Checking devbox desktop preview')

  const existingService = (instance.networking?.httpServices || []).find(s => s.name === DESKTOP_SERVICE)
  if (existingService) {
    emit(ctx, requestId, 'desktop', 'Reusing existing web VNC preview')
    return
  }

  const existingPreviewCheck = await instance.exec("bash -lc 'curl -I --max-time 3 http://127.0.0.1:6080/vnc_lite.html >/dev/null 2>&1 || curl -I --max-time 3 http://127.0.0.1:6080/vnc.html >/dev/null 2>&1'", { timeout: 10 }).catch(() => null)
  if (existingPreviewCheck && existingPreviewCheck.exit_code === 0) {
    emit(ctx, requestId, 'desktop', 'Found existing local noVNC service, exposing it')
    await instance.exposeHttpService(DESKTOP_SERVICE, 6080).catch(async (err) => {
      const fresh = await instance.client.instances.get({ instanceId: instance.id }).catch(() => null)
      const existing = fresh?.networking?.httpServices?.find(s => s.name === DESKTOP_SERVICE)
      if (!existing) throw err
    })
    await instance.setWakeOn(undefined, true).catch(() => {})
    return
  }

  emit(ctx, requestId, 'desktop', 'Installing desktop + noVNC packages')

  const escapedPassword = shellEscape(password || 'morph')
  const escapedStartup = startupCommand ? shellEscape(startupCommand) : "''"

  const script = `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y xfce4 xfce4-terminal dbus-x11 x11-xserver-utils tigervnc-standalone-server novnc websockify curl
mkdir -p /root/.vnc
printf %s ${escapedPassword} | vncpasswd -f > /root/.vnc/passwd
chmod 600 /root/.vnc/passwd
cat > /root/.vnc/xstartup <<'EOF'
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
xrdb "$HOME/.Xresources" >/dev/null 2>&1 || true
startxfce4 &
EOF
chmod +x /root/.vnc/xstartup
vncserver -kill :1 >/dev/null 2>&1 || true
pkill -f 'websockify.+6080' >/dev/null 2>&1 || true
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 >/dev/null 2>&1 || true
vncserver :1 -geometry 1440x900 -depth 24 -localhost no
nohup websockify --web=/usr/share/novnc/ 6080 localhost:5901 >/tmp/morph-websockify.log 2>&1 &
sleep 3
if [ ${escapedStartup} != '' ]; then
  nohup bash -lc ${escapedStartup} >/tmp/morph-startup.log 2>&1 &
fi
curl -I http://127.0.0.1:6080/vnc_lite.html >/dev/null 2>&1 || curl -I http://127.0.0.1:6080/vnc.html >/dev/null 2>&1`

  await instance.exec(script, { timeout: 900 })

  emit(ctx, requestId, 'desktop', 'Exposing preview service')
  try {
    await instance.exposeHttpService(DESKTOP_SERVICE, 6080)
  } catch (err) {
    const fresh = await instance.client.instances.get({ instanceId: instance.id }).catch(() => null)
    const existing = fresh?.networking?.httpServices?.find(s => s.name === DESKTOP_SERVICE)
    if (!existing) throw err
  }

  await instance.setWakeOn(undefined, true).catch(() => {})
}

module.exports = {
  activate(ctx) {
    ctx.log('Morph extension activated')

    function makeClient(config) {
      const apiKey = String(config.apiKey || ctx.settings.get('apiKey') || '').trim()
      if (!apiKey) throw new Error('Morph API key is required')
      const baseUrl = String(config.baseUrl || ctx.settings.get('baseUrl') || 'https://cloud.morph.so/api').trim()
      return new MorphCloudClient({ apiKey, baseUrl: baseUrl || undefined })
    }

    async function listInstances(config = {}) {
      const client = makeClient(config)
      const instances = await client.instances.list()
      return instances
        .filter(instance => {
          const metadata = instance.metadata || {}
          return metadata[INSTANCE_TAG] === INSTANCE_TAG_VALUE
            || metadata.source === 'contex-morph-extension'
            || String(metadata.label || '').toLowerCase().includes('devbox')
            || String(instance.refs?.imageId || '').toLowerCase().includes('devbox')
            || (instance.networking?.httpServices || []).some(service => String(service.name || '').toLowerCase().includes('desktop'))
        })
        .sort((a, b) => b.created - a.created)
        .map(summarizeInstance)
    }

    ctx.ipc.handle('listInstances', async (args) => {
      const config = parseArgs(args)
      return { instances: await listInstances(config) }
    })

    ctx.ipc.handle('listDevboxes', async (args) => {
      const config = parseArgs(args)
      return { devboxes: await listInstances(config) }
    })

    ctx.ipc.handle('listTemplates', async (args) => {
      const config = parseArgs(args)
      const client = makeClient(config)
      const [snapshots, images] = await Promise.all([
        client.snapshots.list().catch(() => []),
        client.images.list().catch(() => []),
      ])
      return {
        snapshots: snapshots
          .filter(s => s.status === 'ready')
          .sort((a, b) => b.created - a.created)
          .map(summarizeSnapshot),
        images: images
          .sort((a, b) => b.created - a.created)
          .map(summarizeImage),
      }
    })

    ctx.ipc.handle('createInstance', async (args) => {
      const input = parseArgs(args)
      const requestId = input.requestId || `morph-${Date.now()}`
      const client = makeClient(input)
      const label = String(input.label || DEFAULT_DEVBOX_LABEL).trim() || DEFAULT_DEVBOX_LABEL
      const ttlSeconds = Number(input.ttlSeconds || 0) || undefined
      const ttlAction = input.ttlAction === 'pause' ? 'pause' : 'stop'
      const startupCommand = String(input.startupCommand || '').trim()
      const desktopPassword = String(input.desktopPassword || 'morph')

      emit(ctx, requestId, 'snapshot', 'Preparing Morph devbox template')

      const snapshotId = String(input.snapshotId || '').trim()
      const snapshot = snapshotId
        ? await client.snapshots.get({ snapshotId })
        : await client.snapshots.create({
            imageId: String(input.imageId || 'morphvm-minimal').trim() || 'morphvm-minimal',
            vcpus: Number(input.vcpus || 2),
            memory: Number(input.memory || 4096),
            diskSize: Number(input.diskSize || 12288),
            metadata: {
              [INSTANCE_TAG]: INSTANCE_TAG_VALUE,
              source: 'contex-morph-extension',
              label,
            },
          })

      emit(ctx, requestId, 'instance', 'Starting Morph devbox')
      const instance = await client.instances.start({
        snapshotId: snapshot.id,
        ttlSeconds,
        ttlAction,
        timeout: 300,
        metadata: {
          [INSTANCE_TAG]: INSTANCE_TAG_VALUE,
          source: 'contex-morph-extension',
          label,
        },
      })

      emit(ctx, requestId, 'instance', `Devbox ${instance.id} is ready`, { instanceId: instance.id })
      await ensureDesktop(instance, desktopPassword, startupCommand, ctx, requestId)

      const fresh = await client.instances.get({ instanceId: instance.id })
      const summary = summarizeInstance(fresh)
      summary.previewUrl = previewUrlFor(summary.previewBaseUrl)

      ctx.bus.publish(BUS_CHANNEL, 'data', {
        action: 'instanceCreated',
        requestId,
        instance: summary,
      })

      return { ok: true, instance: summary, devbox: summary }
    })

    ctx.ipc.handle('createDevbox', async (args) => {
      return ctx.ipc.invoke ? ctx.ipc.invoke('createInstance', args) : null
    })

    ctx.ipc.handle('saveAsTemplate', async (args) => {
      const input = parseArgs(args)
      const client = makeClient(input)
      if (!input.instanceId) throw new Error('instanceId is required')
      const instance = await client.instances.get({ instanceId: String(input.instanceId) })
      const label = String(input.label || (instance.metadata && instance.metadata.label) || `${instance.id} template`).trim()
      const snapshot = await instance.snapshot({
        metadata: {
          [INSTANCE_TAG]: INSTANCE_TAG_VALUE,
          source: 'contex-morph-extension',
          label,
          template: 'true',
        },
      })
      const summary = summarizeSnapshot(snapshot)
      ctx.bus.publish(BUS_CHANNEL, 'data', {
        action: 'templateSaved',
        instanceId: String(input.instanceId),
        snapshot: summary,
      })
      return { ok: true, snapshot: summary }
    })

    ctx.ipc.handle('stopInstance', async (args) => {
      const input = parseArgs(args)
      const client = makeClient(input)
      if (!input.instanceId) throw new Error('instanceId is required')
      await client.instances.stop({ instanceId: String(input.instanceId) })
      ctx.bus.publish(BUS_CHANNEL, 'data', {
        action: 'instanceStopped',
        instanceId: String(input.instanceId),
      })
      return { ok: true }
    })

    ctx.ipc.handle('getPreviewUrl', async (args) => {
      const input = parseArgs(args)
      const client = makeClient(input)
      if (!input.instanceId) throw new Error('instanceId is required')
      const instance = await client.instances.get({ instanceId: String(input.instanceId) })
      const summary = summarizeInstance(instance)
      if (!summary.previewBaseUrl) throw new Error('No desktop preview service found on this instance')
      return {
        ok: true,
        instance: summary,
        previewUrl: previewUrlFor(summary.previewBaseUrl),
      }
    })

    return () => {
      ctx.log('Morph extension deactivated')
    }
  },
}

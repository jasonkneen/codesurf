import { CodesurfRelay } from '../src'

async function main() {
  const relay = new CodesurfRelay({ workspacePath: process.cwd() })
  await relay.init()

  await relay.upsertParticipant({
    id: 'designer',
    name: 'Designer',
    kind: 'human',
    status: 'ready',
    channels: ['launch'],
  })

  await relay.upsertParticipant({
    id: 'frontend-agent',
    name: 'Frontend Agent',
    kind: 'agent',
    status: 'ready',
    channels: ['launch'],
  })

  await relay.updateWorkContext('frontend-agent', {
    summary: 'Preparing release notes UI and inbox panel',
    branch: 'feature/relay-ui',
    worktreePath: process.cwd(),
    files: ['src/renderer/src/App.tsx'],
    impacts: [{ targetType: 'human', targetId: 'designer', description: 'Needs visual sign-off before merge', severity: 'medium' }],
  })

  await relay.sendChannelMessage('frontend-agent', {
    channel: 'launch',
    subject: 'Release UI update',
    body: 'Inbox panel scaffolding is ready for review.',
    kind: 'update',
  })

  console.log(await relay.listCentralFeed(10))
  console.log(await relay.analyzeRelationships())
}

void main()

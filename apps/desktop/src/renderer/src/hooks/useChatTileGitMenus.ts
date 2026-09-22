import { useCallback, useEffect, useMemo } from 'react'
import { basename } from '../utils/dnd'
import type { ChatMessage } from '../../../shared/chat-types'
import type { useChatGitState } from './useChatGitState'

type GitState = ReturnType<typeof useChatGitState>

export function useChatTileGitMenus(options: {
  workspaceDir: string
  workspaceId: string
  executionTarget: 'local' | 'cloud'
  executionDisplayDetail: string
  gitStatus: GitState['gitStatus']
  gitBranches: GitState['gitBranches']
  refreshGitState: GitState['refreshGitState']
  branchFilter: string
  setBranchFilter: (value: string) => void
  setShowBranchMenu: (value: boolean) => void
  executionTargetCloud: boolean
  remoteHosts: Array<{ id: string }>
  cloudHostId: string | null
  setCloudHostId: (value: string | null) => void
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
}) {
  const {
    workspaceDir,
    workspaceId,
    executionTarget,
    executionDisplayDetail,
    gitStatus,
    gitBranches,
    refreshGitState,
    branchFilter,
    setBranchFilter,
    setShowBranchMenu,
    remoteHosts,
    cloudHostId,
    setCloudHostId,
    setMessages,
  } = options

  const isGitRepo = gitStatus.isRepo || gitBranches.isRepo
  const branchMenuCreateEnabled = isGitRepo
    && branchFilter.trim().length > 0
    && !gitBranches.branches.some(branch => branch.name.toLowerCase() === branchFilter.trim().toLowerCase())
  const activeRepoRoot = gitBranches.isRepo
    ? gitBranches.root
    : gitStatus.isRepo
      ? gitStatus.root
      : workspaceDir
  const normalizedRepoRoot = activeRepoRoot.replace(/\/+$/, '')
  const projectFolderName = basename(normalizedRepoRoot) || 'No project'
  const currentBranchLabel = gitBranches.current ?? 'No branch'

  useEffect(() => {
    if (executionTarget !== 'cloud') return
    if (remoteHosts.length === 0) {
      if (cloudHostId !== null) setCloudHostId(null)
      return
    }
    if (!cloudHostId || !remoteHosts.some(host => host.id === cloudHostId)) {
      setCloudHostId(remoteHosts[0].id)
    }
  }, [executionTarget, remoteHosts, cloudHostId, setCloudHostId])

  const activeProjectPathLabel = executionTarget === 'cloud'
    ? executionDisplayDetail
    : (normalizedRepoRoot || 'No project')

  const handleProjectFolderSwitch = useCallback(async () => {
    try {
      const newPath = await window.electron?.workspace?.openFolder?.()
      if (!newPath) return
      const previousPath = normalizedRepoRoot || ''
      if (newPath === previousPath) return
      if (workspaceId) {
        try {
          await window.electron?.workspace?.addProjectFolder?.(workspaceId, newPath)
        } catch (err) {
          console.warn('[ChatTile] addProjectFolder failed:', err)
        }
      }
      const switchMsg: ChatMessage = {
        id: `msg-folder-switch-${Date.now()}`,
        role: 'assistant',
        content: previousPath
          ? `Switched project folder from \`${previousPath}\` to \`${newPath}\`.`
          : `Switched project folder to \`${newPath}\`.`,
        timestamp: Date.now(),
      }
      setMessages(prev => [...prev, switchMsg])
    } catch (err) {
      console.warn('[ChatTile] folder switch failed:', err)
    }
  }, [normalizedRepoRoot, workspaceId, setMessages])

  const filteredBranches = useMemo(() => {
    const query = branchFilter.trim().toLowerCase()
    if (!query) return gitBranches.branches
    return gitBranches.branches.filter(branch => branch.name.toLowerCase().includes(query))
  }, [gitBranches.branches, branchFilter])

  const handleBranchSelect = useCallback(async (branchName: string) => {
    if (!workspaceDir || !window.electron?.git?.checkoutBranch) return
    const result = await window.electron.git.checkoutBranch(workspaceDir, branchName)
    if (result?.ok) {
      setShowBranchMenu(false)
      setBranchFilter('')
      void refreshGitState()
    }
  }, [workspaceDir, refreshGitState, setShowBranchMenu, setBranchFilter])

  const handleCreateBranch = useCallback(async () => {
    const nextName = branchFilter.trim()
    if (!nextName || !workspaceDir || !window.electron?.git?.createBranch) return
    const result = await window.electron.git.createBranch(workspaceDir, nextName)
    if (result?.ok) {
      setShowBranchMenu(false)
      setBranchFilter('')
      void refreshGitState()
    }
  }, [branchFilter, workspaceDir, refreshGitState, setShowBranchMenu, setBranchFilter])

  return {
    isGitRepo,
    branchMenuCreateEnabled,
    normalizedRepoRoot,
    projectFolderName,
    currentBranchLabel,
    activeProjectPathLabel,
    filteredBranches,
    handleProjectFolderSwitch,
    handleBranchSelect,
    handleCreateBranch,
  }
}
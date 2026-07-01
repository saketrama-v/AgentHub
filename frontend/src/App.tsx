import { useState, useEffect, useRef, useCallback, memo } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { SignedIn, SignedOut, SignIn, UserButton } from '@clerk/clerk-react'
import { AnsiUp } from 'ansi_up'
import { SmokeBackground } from '@/components/ui/spooky-smoke-animation'
import { Light as SyntaxHighlighter } from 'react-syntax-highlighter'
import { atomOneDark } from 'react-syntax-highlighter/dist/esm/styles/hljs'

// Register only the languages we need (keeps bundle small)
import python from 'react-syntax-highlighter/dist/esm/languages/hljs/python'
import typescript from 'react-syntax-highlighter/dist/esm/languages/hljs/typescript'
import javascript from 'react-syntax-highlighter/dist/esm/languages/hljs/javascript'
import xml from 'react-syntax-highlighter/dist/esm/languages/hljs/xml'   // html
import css from 'react-syntax-highlighter/dist/esm/languages/hljs/css'
import json from 'react-syntax-highlighter/dist/esm/languages/hljs/json'
import markdown from 'react-syntax-highlighter/dist/esm/languages/hljs/markdown'
import yaml from 'react-syntax-highlighter/dist/esm/languages/hljs/yaml'
import bash from 'react-syntax-highlighter/dist/esm/languages/hljs/bash'
import dockerfile from 'react-syntax-highlighter/dist/esm/languages/hljs/dockerfile'

SyntaxHighlighter.registerLanguage('python', python)
SyntaxHighlighter.registerLanguage('typescript', typescript)
SyntaxHighlighter.registerLanguage('javascript', javascript)
SyntaxHighlighter.registerLanguage('html', xml)
SyntaxHighlighter.registerLanguage('css', css)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('markdown', markdown)
SyntaxHighlighter.registerLanguage('yaml', yaml)
SyntaxHighlighter.registerLanguage('bash', bash)
SyntaxHighlighter.registerLanguage('dockerfile', dockerfile)

const ansiUp = new AnsiUp()
ansiUp.use_classes = true

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000'

// ─── Types ─────────────────────────────────────────────────────────────────

interface Session {
  id: string
  name: string
  prompt: string
  status: 'running' | 'done' | 'error'
  started_at: string
  finished_at: string | null
  file_count: number
}

interface WorkspaceFile {
  path: string
  size: number
  modified: number
}

// ─── Constants ─────────────────────────────────────────────────────────────

const AGENTS = [
  { key: 'librarian',         label: 'Librarian',  emoji: '📚' },
  { key: 'tech_lead',         label: 'Tech Lead',  emoji: '🏗️' },
  { key: 'backend_engineer',  label: 'Backend',    emoji: '⚙️' },
  { key: 'frontend_engineer', label: 'Frontend',   emoji: '🎨' },
  { key: 'senior_dev',        label: 'Senior Dev', emoji: '🔍' },
  { key: 'qa_engineer',       label: 'QA',         emoji: '🧪' },
  { key: 'security_admin',    label: 'Security',   emoji: '🔒' },
  { key: 'devops_specialist', label: 'DevOps',     emoji: '🐳' },
]

const EXT_LANG: Record<string, string> = {
  py: 'python', ts: 'typescript', tsx: 'typescript', js: 'javascript',
  jsx: 'javascript', html: 'html', css: 'css', json: 'json',
  md: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'bash', dockerfile: 'dockerfile',
}

function fileIcon(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const m: Record<string, string> = {
    py: '🐍', ts: '📘', tsx: '⚛️', js: '📜', jsx: '⚛️',
    html: '🌐', css: '🎨', json: '📋', md: '📝',
    yml: '⚙️', yaml: '⚙️', sh: '💻', dockerfile: '🐳',
  }
  return m[ext] ?? '📄'
}

function statusPill(status: Session['status']) {
  const base = 'text-[9px] px-1.5 py-0.5 rounded-full border font-mono uppercase leading-none'
  if (status === 'done')    return `${base} text-[#3DDC97] border-[#3DDC97]/40 bg-[#3DDC97]/10`
  if (status === 'error')   return `${base} text-red-400 border-red-500/40 bg-red-500/10`
  return `${base} text-amber-400 border-amber-400/40 bg-amber-400/10 animate-pulse`
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const LogLine = memo(({ log }: { log: string }) => {
  return <div className="mb-[1px]" dangerouslySetInnerHTML={{ __html: ansiUp.ansi_to_html(log) }} />
})

// ─── Component ─────────────────────────────────────────────────────────────

export default function App() {
  // Terminal Center View
  const [logs, setLogs]                   = useState<string[]>([])
  const [isProcessing, setIsProcessing]   = useState(false)
  const [execStatus, setExecStatus]       = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [activeTab, setActiveTab]         = useState<'terminal' | 'editor'>('terminal')

  // HITL
  const [awaitingHuman, setAwaitingHuman] = useState(false)
  const [humanFeedback, setHumanFeedback] = useState('')

  // Kickoff form
  const [prompt, setPrompt]               = useState('')
  const [sessionName, setSessionName]     = useState('')
  const [showAgentConfig, setShowAgentConfig] = useState(false)
  const [selectedAgents, setSelectedAgents]   = useState<string[]>(AGENTS.map(a => a.key))
  const [resumeSessionId, setResumeSessionId] = useState<string | null>(null)

  // Sidebar (Sessions)
  const [sidebarOpen, setSidebarOpen]         = useState(true)
  const [sessions, setSessions]               = useState<Session[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [deletingId, setDeletingId]           = useState<string | null>(null)
  const [renamingId, setRenamingId]           = useState<string | null>(null)
  const [renameValue, setRenameValue]         = useState('')
  const [clearAllConfirm, setClearAllConfirm] = useState(false)

  // Workspace panel
  const [workspaceOpen, setWorkspaceOpen] = useState(true)
  const [wsFiles, setWsFiles]             = useState<WorkspaceFile[]>([])
  const [selectedFile, setSelectedFile]   = useState<string | null>(null)
  const [fileContent, setFileContent]     = useState('')
  const [loadingFile, setLoadingFile]     = useState(false)

  // Settings panel
  const [showSettings, setShowSettings]   = useState(false)
  const [configValues, setConfigValues]   = useState<Record<string, string>>({})
  const [configEdits, setConfigEdits]     = useState<Record<string, string>>({})
  const [configSaving, setConfigSaving]   = useState(false)
  const [configSaved, setConfigSaved]     = useState(false)

  const terminalRef   = useRef<HTMLDivElement>(null)
  const wsRef         = useRef<WebSocket | null>(null)
  const humanInputRef = useRef<HTMLTextAreaElement>(null)

  // ── Auto-scroll terminal ───────────────────────────────────────────────
  useEffect(() => {
    if (activeTab === 'terminal' && terminalRef.current)
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight
  }, [logs, activeTab])

  useEffect(() => {
    if (awaitingHuman && humanInputRef.current) humanInputRef.current.focus()
  }, [awaitingHuman])

  // ── Sessions poll ──────────────────────────────────────────────────────
  const fetchSessions = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/api/sessions`)
      if (r.ok) setSessions((await r.json()).sessions ?? [])
    } catch { /* backend offline */ }
  }, [])

  useEffect(() => {
    fetchSessions()
    const id = setInterval(fetchSessions, 5000)
    return () => clearInterval(id)
  }, [fetchSessions])

  // ── Log history restore when switching sessions ────────────────────────
  const fetchLogs = useCallback(async (sid: string) => {
    try {
      const r = await fetch(`${API_URL}/api/sessions/${sid}/logs`)
      if (r.ok) {
        const text = await r.text()
        if (text.trim()) {
          const lines = text.split('\n').filter(l => l.length > 0)
          setLogs(['📜 — Log history restored — 📜', ...lines])
        } else {
          setLogs(['(No log history for this session)'])
        }
      }
    } catch { /* ignore */ }
  }, [])

  // ── Workspace files poll ───────────────────────────────────────────────
  const fetchSessionFiles = useCallback(async (sid: string) => {
    try {
      const r = await fetch(`${API_URL}/api/sessions/${sid}/files`)
      if (r.ok) setWsFiles((await r.json()).files ?? [])
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (!activeSessionId) return
    if (execStatus !== 'running' || resumeSessionId === activeSessionId) {
      fetchLogs(activeSessionId)
    }
    fetchSessionFiles(activeSessionId)
    const id = setInterval(() => fetchSessionFiles(activeSessionId), 3000)
    return () => clearInterval(id)
  }, [activeSessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Config fetch ───────────────────────────────────────────────────────
  const fetchConfig = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/api/config`)
      if (r.ok) {
        const data = (await r.json()).config ?? {}
        setConfigValues(data)
        setConfigEdits(data)
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (showSettings) fetchConfig()
  }, [showSettings, fetchConfig])

  // ── WebSocket ──────────────────────────────────────────────────────────
  useEffect(() => {
    const ws = new WebSocket(`${WS_URL}/ws`)
    wsRef.current = ws
    ws.onopen = () => setLogs(['✅ Connected to AgentHub Engine! Waiting for kickoff...'])
    ws.onmessage = ({ data }: MessageEvent<string>) => {
      if (data.trim() === '__HUMAN_INPUT_REQUIRED__') {
        setAwaitingHuman(true)
        setLogs(prev => {
          let next = prev;
          if (next.length > 0 && next[0].includes('Waiting for kickoff')) next = next.slice(1);
          return [...next, '🤝 Agent is requesting your feedback. Type below and press Send.']
        })
        return
      }
      if (data.startsWith('__SESSION_STARTED__:')) {
        const sid = data.split(':')[1]
        setActiveSessionId(sid); setExecStatus('running')
        setSelectedFile(null); setWsFiles([])
        setActiveTab('terminal')
        setLogs([]) 
        fetchSessions(); return
      }
      if (data.trim() === '__EXECUTION_COMPLETE__') {
        setExecStatus('done'); setIsProcessing(false); fetchSessions()
        if (activeSessionId) fetchSessionFiles(activeSessionId); return
      }
      if (data.trim() === '__EXECUTION_FAILED__') {
        setExecStatus('error'); setIsProcessing(false); fetchSessions(); return
      }
      setLogs(prev => {
        let next = prev;
        if (next.length > 0 && next[0].includes('Waiting for kickoff')) next = next.slice(1);
        next = [...next, data];
        if (next.length > 5000) return next.slice(next.length - 5000);
        return next;
      })
      setIsProcessing(true)
    }
    ws.onclose = (e) => {
      if (!e.wasClean) setLogs(prev => [...prev, '🔌 Connection to Python Backend lost.'])
      setIsProcessing(false)
    }
    return () => { ws.onclose = null; ws.close() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Kickoff ────────────────────────────────────────────────────────────
  const handleKickoff = async () => {
    if (!prompt.trim() || isProcessing) return
    setIsProcessing(true); setExecStatus('running')
    setLogs([]); setSelectedFile(null); setWsFiles([])
    setActiveTab('terminal')
    try {
      await fetch(`${API_URL}/api/kickoff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_prompt: prompt,
          session_name: resumeSessionId ? undefined : (sessionName.trim() || undefined),
          agents: selectedAgents,
          resume_session_id: resumeSessionId || undefined,
        }),
      })
    } catch {
      setLogs(prev => [...prev, '[Connection Error] Failed to reach backend API!'])
      setIsProcessing(false); setExecStatus('error')
    } finally {
      setPrompt(''); setSessionName(''); setResumeSessionId(null)
    }
  }

  const handleResume = (s: Session) => {
    setResumeSessionId(s.id); setActiveSessionId(s.id)
    setPrompt(''); setActiveTab('terminal')
    setLogs([`▶ Resuming session "${s.name}" — type your next instruction below.`])
  }

  const handleDelete = async (sid: string) => {
    try {
      await fetch(`${API_URL}/api/sessions/${sid}`, { method: 'DELETE' })
      if (activeSessionId === sid) { setActiveSessionId(null); setWsFiles([]) }
      fetchSessions()
    } catch { /* ignore */ }
    setDeletingId(null)
  }

  const handleClearAll = async () => {
    await Promise.all(sessions.map(s =>
      fetch(`${API_URL}/api/sessions/${s.id}`, { method: 'DELETE' })
    ))
    setActiveSessionId(null); setWsFiles([]); setLogs([])
    fetchSessions(); setClearAllConfirm(false)
  }

  const handleRename = async (sid: string) => {
    if (!renameValue.trim()) { setRenamingId(null); return }
    try {
      await fetch(`${API_URL}/api/sessions/${sid}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: renameValue.trim() }),
      })
      fetchSessions()
    } catch { /* ignore */ }
    setRenamingId(null)
  }

  const submitHumanFeedback = () => {
    const text = humanFeedback.trim()
    if (!text || !wsRef.current) return
    setLogs(prev => [...prev, `> ${text}`])
    wsRef.current.send(`HUMAN_INPUT:${text}`)
    setHumanFeedback(''); setAwaitingHuman(false)
  }

  // ── File viewer ────────────────────────────────────────────────────────
  const openFile = async (path: string) => {
    if (!activeSessionId) return
    setSelectedFile(path); setLoadingFile(true); setActiveTab('editor')
    try {
      const r = await fetch(`${API_URL}/api/sessions/${activeSessionId}/read?path=${encodeURIComponent(path)}`)
      setFileContent(r.ok ? await r.text() : '(Could not read file)')
    } catch { setFileContent('(Network error)') }
    finally { setLoadingFile(false) }
  }

  const downloadFile = (path: string) =>
    window.open(`${API_URL}/api/sessions/${activeSessionId}/download?path=${encodeURIComponent(path)}`, '_blank')

  const exportZip = () =>
    activeSessionId && window.open(`${API_URL}/api/sessions/${activeSessionId}/export`, '_blank')

  const saveConfig = async () => {
    setConfigSaving(true)
    try {
      await fetch(`${API_URL}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: configEdits }),
      })
      setConfigSaved(true)
      setTimeout(() => setConfigSaved(false), 2500)
    } catch { /* ignore */ }
    finally { setConfigSaving(false) }
  }

  const toggleAgent = (key: string) =>
    setSelectedAgents(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key])

  const statusBadge = () => {
    if (execStatus === 'idle')    return <span className="text-[10px] px-2 py-0.5 rounded-full border border-neutral-700 text-neutral-500">IDLE</span>
    if (execStatus === 'running') return <span className="text-[10px] px-2 py-0.5 rounded-full border border-amber-500/50 bg-amber-500/10 text-amber-400 animate-pulse">● RUNNING</span>
    if (execStatus === 'done')    return <span className="text-[10px] px-2 py-0.5 rounded-full border border-[#3DDC97]/50 bg-[#3DDC97]/10 text-[#3DDC97]">✓ DONE</span>
    return                               <span className="text-[10px] px-2 py-0.5 rounded-full border border-red-500/50 bg-red-500/10 text-red-400">✕ FAILED</span>
  }

  const ext  = selectedFile?.split('.').pop()?.toLowerCase() ?? ''
  const lang = EXT_LANG[ext] ?? 'plaintext'
  const activeSession = sessions.find(s => s.id === activeSessionId)

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <>
      <SignedOut>
        <div className="flex items-center justify-center w-screen h-screen bg-black">
          <SmokeBackground smokeColor="#FF0000" />
          <div className="relative z-10 flex flex-col items-center gap-6">
            <div className="flex items-center gap-3">
              <img src="/logo.png" alt="AgentHub" className="h-12 w-auto object-contain" onError={(e) => { e.currentTarget.style.display = 'none' }} />
              <span className="font-mono font-bold text-2xl tracking-wider text-neutral-200">AgentHub Studio</span>
            </div>
            <SignIn appearance={{ elements: { formButtonPrimary: "bg-red-600 hover:bg-red-500 text-white font-semibold shadow-lg shadow-red-900/20", footerActionLink: "text-red-500 hover:text-red-400" } }} />
          </div>
        </div>
      </SignedOut>
      <SignedIn>
        <div className="relative w-screen h-screen overflow-hidden text-slate-100 flex flex-col bg-black">
          <SmokeBackground smokeColor="#FF0000" />

      {/* ══ SETTINGS OVERLAY ═════════════════════════════════════════════ */}
      {showSettings && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md bg-[#0d0d0d] border border-red-900/40 rounded-2xl shadow-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm tracking-wider text-neutral-200 uppercase">⚙ Settings</span>
              <button onClick={() => setShowSettings(false)} className="text-neutral-500 hover:text-neutral-200 text-lg leading-none transition-all">✕</button>
            </div>
            <div className="flex flex-col gap-3">
              {Object.entries(configEdits).map(([k, v]) => (
                <div key={k} className="flex flex-col gap-1">
                  <label className="font-mono text-[10px] text-neutral-500 uppercase tracking-widest">{k}</label>
                  <input
                    className="bg-black/60 border border-red-900/30 rounded-lg px-3 py-2 text-xs text-neutral-300 font-mono focus:outline-none focus:border-red-500 transition-all"
                    value={v}
                    onChange={e => setConfigEdits(prev => ({ ...prev, [k]: e.target.value }))}
                    placeholder={configValues[k] ?? ''}
                  />
                </div>
              ))}
              {Object.keys(configEdits).length === 0 && (
                <p className="text-xs text-neutral-600 text-center py-4">Loading config…</p>
              )}
            </div>
            <div className="flex items-center justify-between pt-2 border-t border-red-900/20">
              <p className="text-[10px] text-neutral-600">Changes are saved to <code className="text-neutral-400">.env</code> — restart backend to apply.</p>
              <button onClick={saveConfig} disabled={configSaving} className="px-4 py-2 text-xs rounded-xl bg-red-600 hover:bg-red-500 text-white font-semibold transition-all disabled:opacity-50">
                {configSaved ? '✓ Saved!' : configSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══ HEADER ═══════════════════════════════════════════════════════ */}
      <div className="relative z-10 shrink-0 flex items-center px-4 py-2.5 border-b border-red-900/30 bg-black/50 backdrop-blur-md gap-4">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="AgentHub" className="h-8 w-auto object-contain" onError={(e) => { e.currentTarget.style.display = 'none' }} />
          <span className="font-mono font-bold text-sm tracking-wider text-neutral-200">AgentHub Studio</span>
        </div>
        <div className="flex-1" />
        <button onClick={() => setShowSettings(true)} title="Settings" className="p-2 rounded-lg text-neutral-500 hover:text-neutral-200 hover:bg-white/5 transition-all">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
        </button>
        <UserButton appearance={{ elements: { userButtonAvatarBox: "w-8 h-8 rounded-full border border-red-600/50" } }} />
      </div>

      {/* ══ MAIN LAYOUT ══════════════════════════════════════════════════ */}
      <div className="relative z-10 flex-1 flex min-h-0 p-3 gap-3">

        {/* ── SIDEBAR (Sessions) ──────────────────────────────────────── */}
        <div className={`absolute top-3 bottom-3 left-3 z-20 flex flex-col bg-black/50 backdrop-blur-md border border-red-900/30 rounded-2xl shadow-2xl transition-all duration-300 overflow-hidden ${sidebarOpen ? 'w-56' : 'w-10'}`}>
          <div className="flex items-center p-2 border-b border-red-900/30 shrink-0 gap-1">
            {sidebarOpen && <span className="flex-1 font-mono text-[10px] tracking-widest text-neutral-500 uppercase pl-1">Sessions</span>}
            {sidebarOpen && sessions.length > 0 && (
              <button onClick={() => setClearAllConfirm(true)} title="Clear all sessions" className="text-neutral-600 hover:text-red-400 text-[10px] transition-all px-1">🗑 All</button>
            )}
            <button onClick={() => setSidebarOpen(o => !o)} className="text-neutral-500 hover:text-neutral-300 transition-colors p-1 rounded-lg hover:bg-white/5 text-base leading-none ml-auto">
              {sidebarOpen ? '‹' : '›'}
            </button>
          </div>
          {sidebarOpen && (
            <div className="flex-1 overflow-y-auto p-1.5 flex flex-col gap-1 min-h-0">
              {clearAllConfirm && (
                <div className="p-2 rounded-xl border border-red-600/50 bg-red-950/40 flex flex-col gap-1.5 mb-1">
                  <span className="text-[10px] text-red-400">Delete ALL sessions? This is permanent.</span>
                  <div className="flex gap-1">
                    <button onClick={handleClearAll} className="flex-1 text-[10px] py-1 rounded-lg bg-red-600 hover:bg-red-500 text-white transition-all">Delete All</button>
                    <button onClick={() => setClearAllConfirm(false)} className="flex-1 text-[10px] py-1 rounded-lg bg-neutral-800 text-neutral-300 transition-all">Cancel</button>
                  </div>
                </div>
              )}
              {sessions.length === 0
                ? <div className="flex-1 flex items-center justify-center text-center p-3 text-neutral-600 text-[11px] leading-relaxed">No sessions yet.<br />Kick off your first task!</div>
                : sessions.map(s => (
                    <div key={s.id} className="relative group">
                      {deletingId === s.id ? (
                        <div className="p-2 rounded-xl border border-red-600/50 bg-red-950/40 flex flex-col gap-1.5">
                          <span className="text-[10px] text-red-400">Delete "{s.name}"?</span>
                          <div className="flex gap-1">
                            <button onClick={() => handleDelete(s.id)} className="flex-1 text-[10px] py-1 rounded-lg bg-red-600 hover:bg-red-500 text-white transition-all">Yes</button>
                            <button onClick={() => setDeletingId(null)} className="flex-1 text-[10px] py-1 rounded-lg bg-neutral-800 text-neutral-300 transition-all">No</button>
                          </div>
                        </div>
                      ) : renamingId === s.id ? (
                        <div className="p-2 rounded-xl border border-[#3DDC97]/40 bg-[#3DDC97]/5 flex flex-col gap-1.5">
                          <input autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleRename(s.id); if (e.key === 'Escape') setRenamingId(null) }}
                            className="bg-black/60 border border-[#3DDC97]/40 rounded-lg px-2 py-1 text-[11px] text-neutral-200 font-mono w-full focus:outline-none"
                            placeholder="New name…"
                          />
                          <div className="flex gap-1">
                            <button onClick={() => handleRename(s.id)} className="flex-1 text-[10px] py-1 rounded-lg bg-[#3DDC97] text-black font-semibold transition-all">Save</button>
                            <button onClick={() => setRenamingId(null)} className="flex-1 text-[10px] py-1 rounded-lg bg-neutral-800 text-neutral-300 transition-all">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setActiveSessionId(s.id); setSelectedFile(null); setResumeSessionId(null); setActiveTab('terminal') }}
                          className={`text-left w-full p-2 rounded-xl transition-all ${activeSessionId === s.id ? 'bg-red-900/30 border border-red-700/40' : 'hover:bg-white/5 border border-transparent'}`}
                        >
                          <div className="flex items-center gap-1.5 mb-1"><span className={statusPill(s.status)}>{s.status}</span></div>
                          <div className="font-semibold text-[11px] text-neutral-200 truncate">{s.name}</div>
                          <div className="text-[10px] text-neutral-600 truncate mt-0.5">{s.prompt}</div>
                          <div className="text-[9px] text-neutral-600 mt-1">{s.file_count} files · {fmtDate(s.started_at)}</div>
                          <div className="hidden group-hover:flex items-center gap-1 mt-1.5">
                            <button onClick={e => { e.stopPropagation(); handleResume(s) }} className="flex-1 text-[9px] py-1 rounded-lg border border-[#3DDC97]/40 text-[#3DDC97] hover:bg-[#3DDC97]/10 transition-all">▶ Resume</button>
                            <button onClick={e => { e.stopPropagation(); setRenamingId(s.id); setRenameValue(s.name) }} className="text-[9px] px-2 py-1 rounded-lg border border-neutral-700 text-neutral-400 hover:bg-white/5 transition-all">✎</button>
                            <button onClick={e => { e.stopPropagation(); setDeletingId(s.id) }} className="text-[9px] px-2 py-1 rounded-lg border border-red-700/40 text-red-400 hover:bg-red-900/20 transition-all">🗑</button>
                          </div>
                        </button>
                      )}
                    </div>
                  ))
              }
            </div>
          )}
        </div>

        {/* ── CENTRAL AREA (Terminal / Editor) ────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0 bg-black/40 backdrop-blur-md border border-red-900/30 rounded-2xl shadow-2xl overflow-hidden ml-[52px] lg:mr-[52px]">
          
          {/* Header Tabs Navigation */}
          <div className="px-3 border-b border-red-900/30 flex items-center shrink-0 bg-black/50">
            <button
              onClick={() => setActiveTab('terminal')}
              className={`px-4 py-2.5 text-[11px] font-mono tracking-widest uppercase transition-all flex items-center gap-2 border-b-2
                ${activeTab === 'terminal' ? 'border-red-500 text-red-400 bg-red-500/10' : 'border-transparent text-neutral-500 hover:text-neutral-300 hover:bg-white/5'}`}
            >
              <span className={activeTab === 'terminal' && execStatus === 'running' ? 'animate-pulse text-red-500' : ''}>
                {execStatus === 'running' ? '●' : '>_'}
              </span>
              Terminal
            </button>

            <button
              onClick={() => setActiveTab('editor')}
              className={`px-4 py-2.5 text-[11px] font-mono tracking-widest uppercase transition-all flex items-center gap-2 border-b-2
                ${activeTab === 'editor' ? 'border-[#3DDC97] text-[#3DDC97] bg-[#3DDC97]/10' : 'border-transparent text-neutral-500 hover:text-neutral-300 hover:bg-white/5'}`}
            >
              <span>{`</>`}</span>
              Editor
              {selectedFile && <span className="ml-1 px-1.5 py-0.5 rounded border border-neutral-700 text-[9px] text-neutral-400 normal-case tracking-normal">1</span>}
            </button>

            <div className="ml-auto flex items-center gap-2">
              {resumeSessionId && <button onClick={() => { setResumeSessionId(null); setPrompt('') }} className="text-[9px] text-neutral-500 hover:text-neutral-300">✕ Cancel Resume</button>}
              {resumeSessionId && <span className="text-[#3DDC97] border border-[#3DDC97]/30 bg-[#3DDC97]/10 px-2 py-0.5 rounded-full text-[9px]">▶ RESUME</span>}
              {statusBadge()}
            </div>
          </div>

          {/* ────── View Content ────── */}
          {activeTab === 'terminal' ? (
            <div className="flex-1 flex flex-col min-h-0">
               {/* Terminal Output */}
               <div
                className="flex-1 bg-black/60 m-3 mb-0 p-3 rounded-xl border border-red-900/20 font-mono text-xs overflow-hidden text-neutral-200 min-h-0"
                style={{ lineHeight: '1.05', fontFamily: '"Consolas", Monaco, "Courier New", monospace' }}
              >
                {logs.length === 0
                  ? <div className="text-neutral-600">Waiting for system kickoff...</div>
                  : <Virtuoso
                      data={logs}
                      style={{ height: '100%' }}
                      itemContent={(index, log) => <LogLine log={log} />}
                      initialTopMostItemIndex={logs.length - 1}
                      followOutput="smooth"
                    />
                }
              </div>

              {/* Terminal Footer (HITL / Kickoff) */}
              {awaitingHuman ? (
                <div className="mx-3 my-3 p-3 rounded-xl border-2 border-[#3DDC97]/60 bg-[#3DDC97]/5 flex flex-col gap-2 shrink-0">
                  <div className="flex items-center gap-2 text-[#3DDC97] font-mono text-[10px] tracking-widest uppercase font-semibold">
                    <span className="animate-pulse">🤝</span> Agent Awaiting Your Feedback
                  </div>
                  <textarea ref={humanInputRef}
                    className="w-full bg-black/60 border border-[#3DDC97]/40 rounded-xl p-2.5 text-[#3DDC97] font-mono text-xs resize-none h-16 focus:outline-none focus:border-[#3DDC97] transition-all placeholder:text-[#3DDC97]/30"
                    placeholder="Type your feedback…" value={humanFeedback}
                    onChange={e => setHumanFeedback(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitHumanFeedback() }}}
                  />
                  <div className="flex justify-end">
                    <button className="px-4 py-1.5 text-xs rounded-lg bg-[#3DDC97] hover:bg-[#5eead4] text-black font-semibold transition-all" onClick={submitHumanFeedback}>Send ↵</button>
                  </div>
                </div>
              ) : (
                <div className="p-3 border-t border-red-900/30 flex flex-col gap-2 shrink-0 mt-3">
                  {showAgentConfig && (
                    <div className="p-3 rounded-xl border border-red-900/30 bg-black/40 flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[10px] tracking-widest text-neutral-500 uppercase">Active Agents — {selectedAgents.length}/{AGENTS.length}</span>
                        <button onClick={() => setSelectedAgents(AGENTS.map(a => a.key))} className="text-[10px] text-neutral-600 hover:text-neutral-400">Reset All</button>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {AGENTS.map(ag => {
                          const on = selectedAgents.includes(ag.key)
                          return (
                            <button key={ag.key} onClick={() => toggleAgent(ag.key)}
                              className={`px-2.5 py-1 rounded-full text-[11px] font-mono border transition-all ${on ? 'border-[#3DDC97]/60 bg-[#3DDC97]/10 text-[#3DDC97]' : 'border-neutral-700 bg-black/40 text-neutral-600'}`}
                            >
                              {ag.emoji} {ag.label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {!resumeSessionId && (
                    <div className="flex items-center gap-2">
                      <input
                        className="flex-1 bg-black/60 border border-red-900/30 rounded-lg px-3 py-1.5 text-xs text-neutral-300 focus:outline-none focus:border-red-500 transition-all placeholder:text-neutral-700 font-mono"
                        placeholder="Session name (optional)…" value={sessionName} onChange={e => setSessionName(e.target.value)}
                      />
                      <button onClick={() => setShowAgentConfig(o => !o)}
                        className={`px-2.5 py-1.5 text-xs rounded-lg border transition-all font-mono ${showAgentConfig ? 'border-[#3DDC97]/50 bg-[#3DDC97]/10 text-[#3DDC97]' : 'border-neutral-700 text-neutral-500 hover:text-neutral-300'}`}
                      >⚙ {selectedAgents.length}/{AGENTS.length}</button>
                    </div>
                  )}

                  <div className="flex gap-2 items-end">
                    <textarea
                      className="flex-1 bg-black/60 border border-red-900/30 rounded-xl p-3 text-neutral-100 font-sans resize-none h-14 text-sm focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500/50 transition-all placeholder:text-neutral-700"
                      placeholder={resumeSessionId ? 'Type your next instruction…' : 'Type your objective for the engineering team…'}
                      value={prompt} onChange={e => setPrompt(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleKickoff() }}}
                    />
                    <button className="shrink-0 self-end bg-red-600 hover:bg-red-500 text-white font-semibold py-2.5 px-4 text-sm rounded-xl transition-all shadow-lg shadow-red-900/20 disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={handleKickoff} disabled={isProcessing}
                    >
                      {isProcessing ? 'Running…' : resumeSessionId ? 'Resume' : 'Kickoff'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex flex-col min-h-0 bg-black/30">
              {/* Editor View */}
              {!selectedFile ? (
                <div className="flex-1 flex flex-col items-center justify-center p-6 text-center gap-3">
                  <span className="text-3xl opacity-20">{`</>`}</span>
                  <p className="text-xs text-neutral-600 leading-relaxed font-mono tracking-wide">No file selected.<br/>Open a file from the workspace to view its contents.</p>
                </div>
              ) : (
                <div className="flex-1 flex flex-col min-h-0">
                  <div className="flex items-center gap-2 px-4 py-2.5 bg-black/50 border-b border-[#3DDC97]/20 shrink-0">
                    <span className="flex-1 text-xs font-mono text-[#3DDC97] truncate">{fileIcon(selectedFile)} {selectedFile}</span>
                    <button onClick={() => downloadFile(selectedFile)} className="text-[10px] px-2 py-1 rounded-lg bg-[#3DDC97]/10 hover:bg-[#3DDC97]/20 text-[#3DDC97] border border-[#3DDC97]/30 transition-all shrink-0">⬇ Download</button>
                    <button onClick={() => setSelectedFile(null)} className="text-[10px] px-2 py-1 rounded-lg text-neutral-400 hover:text-white hover:bg-red-900/20 transition-all shrink-0">✕ Close</button>
                  </div>
                  <div className="flex-1 overflow-auto min-h-0 bg-[#0d0d0d]">
                    {loadingFile
                      ? <div className="p-4 text-neutral-500 font-mono text-xs animate-pulse">Loading file contents…</div>
                      : lang !== 'plaintext' ? (
                          <SyntaxHighlighter
                            language={lang}
                            style={atomOneDark}
                            customStyle={{ margin: 0, padding: '16px', background: 'transparent', fontSize: '12px', lineHeight: '1.6', height: '100%' }}
                            showLineNumbers lineNumberStyle={{ color: '#3f3f46', minWidth: '3em', paddingRight: '1em' }} wrapLongLines
                          >
                            {fileContent}
                          </SyntaxHighlighter>
                        ) : (
                          <pre className="p-4 text-xs font-mono text-neutral-300 whitespace-pre-wrap break-all leading-relaxed">{fileContent}</pre>
                        )
                    }
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── WORKSPACE SIDEBAR ───────────────────────────────────────── */}
        <div className={`hidden lg:flex absolute top-3 bottom-3 right-3 z-20 flex-col bg-black/40 backdrop-blur-md border border-red-900/30 rounded-2xl shadow-2xl transition-all duration-300 overflow-hidden ${workspaceOpen ? 'w-[260px]' : 'w-10'}`}>
          <div className="p-2 border-b border-red-900/30 font-mono text-[10px] tracking-widest text-neutral-500 uppercase flex items-center justify-between shrink-0">
            <button onClick={() => setWorkspaceOpen(o => !o)} className="text-neutral-500 hover:text-neutral-300 transition-colors p-1 rounded-lg hover:bg-white/5 text-base leading-none">
              {workspaceOpen ? '›' : '‹'}
            </button>
            {workspaceOpen && (
              <>
                <span className="truncate flex-1 ml-2">📁 {activeSession?.name ?? 'Workspace'}</span>
                {wsFiles.length > 0 && <span className="text-neutral-600 shrink-0 ml-2">{wsFiles.length}</span>}
              </>
            )}
          </div>

          {workspaceOpen && (
            <>
              {!activeSessionId ? (
                <div className="flex-1 flex flex-col items-center justify-center p-6 text-center gap-3">
                  <span className="text-3xl opacity-20">📂</span>
                  <p className="text-xs text-neutral-600 leading-relaxed">No session active.</p>
                </div>
              ) : wsFiles.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center p-6 text-center gap-3">
                  <span className={`text-2xl ${execStatus === 'running' ? 'animate-pulse' : 'opacity-20'}`}>{execStatus === 'running' ? '⏳' : '📭'}</span>
                  <p className="text-xs text-neutral-600 leading-relaxed">{execStatus === 'running' ? 'Agents working…' : 'No files yet.'}</p>
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto p-2 min-h-0">
                  <div className="flex flex-col gap-[2px]">
                    {wsFiles.map(f => (
                      <button key={f.path} onClick={() => openFile(f.path)} className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition-all group w-full ${selectedFile === f.path ? 'bg-[#3DDC97]/10' : 'hover:bg-white/5'}`}>
                        <span className="text-sm shrink-0">{fileIcon(f.path)}</span>
                        <span className={`flex-1 font-mono text-[11px] transition-colors truncate ${selectedFile === f.path ? 'text-[#3DDC97]' : 'text-neutral-300 group-hover:text-[#3DDC97]'}`}>{f.path}</span>
                        <span className="text-[9px] text-neutral-600 shrink-0">{(f.size / 1024).toFixed(1)}k</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {activeSessionId && wsFiles.length > 0 && (
                <div className="p-2.5 border-t border-red-900/30 shrink-0">
                  <button onClick={exportZip} className="w-full text-center text-xs py-2 px-3 rounded-xl bg-[#3DDC97]/10 hover:bg-[#3DDC97]/20 text-[#3DDC97] border border-[#3DDC97]/30 transition-all font-mono">
                    ⬇ Export .zip
                  </button>
                </div>
              )}
            </>
          )}
        </div>

      </div>
    </div>
      </SignedIn>
    </>
  )
}

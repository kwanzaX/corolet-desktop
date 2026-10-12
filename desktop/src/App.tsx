import { useEffect, useRef, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  AppBar,
  Box,
  Button,
  Chip,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material';
import { useChat, type Status, type Turn } from './store';
import { pickTextFiles } from './files';

const STATUS: Record<Status, { label: string; color: 'success' | 'error' | 'default' }> = {
  connected: { label: 'Connected', color: 'success' },
  connecting: { label: 'Connecting…', color: 'default' },
  disconnected: { label: 'Disconnected', color: 'error' },
  unreachable: { label: 'Server unreachable', color: 'error' },
};

export function App() {
  const connect = useChat((s) => s.connect);
  useEffect(() => connect(), [connect]);

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
      <TopBar />
      <Box
        component="main"
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gap: 1.5,
          p: 1.5,
          gridTemplateColumns: { xs: '1fr', md: 'minmax(240px, 320px) 1fr' },
          gridTemplateRows: { xs: 'auto 1fr', md: '1fr' },
        }}
      >
        <MemoryPanel />
        <ChatPanel />
      </Box>
    </Box>
  );
}

/** Commits on blur or Enter, so the socket is not reconnected on every keystroke. */
function SettingField(props: { label: string; value: string; onCommit: (v: string) => void; width: number }) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => draft.trim() !== props.value && props.onCommit(draft);
  return (
    <TextField
      size="small"
      label={props.label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      slotProps={{ htmlInput: { spellCheck: false } }}
      sx={{ width: props.width }}
    />
  );
}

function TopBar() {
  const { serverUrl, workspace, status, setServerUrl, setWorkspace } = useChat();
  const s = STATUS[status];
  return (
    <AppBar position="static" color="default" elevation={0} sx={{ borderBottom: 1, borderColor: 'divider' }}>
      <Toolbar sx={{ gap: 1.5, flexWrap: 'wrap', py: 1 }}>
        <Typography variant="subtitle1" fontWeight={700} sx={{ mr: 'auto' }}>
          Corolet Desktop
        </Typography>
        <SettingField label="Server" value={serverUrl} onCommit={setServerUrl} width={230} />
        <SettingField label="Workspace" value={workspace} onCommit={setWorkspace} width={140} />
        <Chip role="status" label={s.label} color={s.color} variant="outlined" size="small" />
      </Toolbar>
    </AppBar>
  );
}

function MemoryPanel() {
  const { stored, storeText } = useChat();
  const [source, setSource] = useState('');
  const [text, setText] = useState('');

  const addFiles = async () => {
    for (const f of await pickTextFiles()) await storeText(f.name, f.text);
  };
  const savePasted = async () => {
    if (!text.trim()) return;
    await storeText(source.trim() || 'pasted.md', text);
    setText('');
  };

  return (
    <Paper variant="outlined" component="section" aria-label="Memory" sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5, minHeight: 0 }}>
      <Typography variant="overline" color="text.secondary">
        Memory
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Add a .md or .txt file. It is split, embedded and stored in this workspace.
      </Typography>
      <Button variant="contained" onClick={addFiles}>
        Add file…
      </Button>
      <Accordion disableGutters variant="outlined">
        <AccordionSummary>Or paste text</AccordionSummary>
        <AccordionDetails>
          <Stack gap={1}>
            <TextField size="small" label="Name" placeholder="notes.md" value={source} onChange={(e) => setSource(e.target.value)} />
            <TextField label="Document text" multiline minRows={4} value={text} onChange={(e) => setText(e.target.value)} />
            <Button variant="outlined" onClick={savePasted}>
              Store text
            </Button>
          </Stack>
        </AccordionDetails>
      </Accordion>
      <List dense aria-label="Stored documents" aria-live="polite" sx={{ overflow: 'auto' }}>
        {stored.map((d) => (
          <ListItem key={d.key} disableGutters>
            <ListItemText
              primary={`${d.source}: ${d.text}`}
              slotProps={{
                primary: { color: d.ok === undefined ? 'text.secondary' : d.ok ? 'success.main' : 'error.main', variant: 'body2' },
              }}
            />
          </ListItem>
        ))}
      </List>
    </Paper>
  );
}

function ChatPanel() {
  const { turns, activeId, status, ask, stop } = useChat();
  const [question, setQuestion] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const last = turns.at(-1);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns.length, last?.answer]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() || activeId || status !== 'connected') return;
    ask(question);
    setQuestion('');
  };

  return (
    <Paper variant="outlined" component="section" aria-label="Ask" sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5, minHeight: 0, minWidth: 0 }}>
      <Typography variant="overline" color="text.secondary">
        Ask
      </Typography>
      <Box ref={logRef} role="log" aria-live="polite" sx={{ flex: 1, overflow: 'auto', display: 'grid', alignContent: 'start', gap: 2 }}>
        {turns.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            Answers stream here, with the passages they came from.
          </Typography>
        )}
        {turns.map((t) => (
          <TurnView key={t.id} turn={t} />
        ))}
      </Box>
      <Box component="form" onSubmit={submit} sx={{ display: 'flex', gap: 1 }}>
        <TextField
          fullWidth
          size="small"
          label="Question"
          placeholder="Ask about this workspace's documents"
          autoComplete="off"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        {activeId ? (
          <Button variant="outlined" color="error" onClick={stop}>
            Stop
          </Button>
        ) : (
          <Button type="submit" variant="contained" disabled={status !== 'connected'}>
            Ask
          </Button>
        )}
      </Box>
    </Paper>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  const muted = turn.state === 'refused' || turn.state === 'stopped';
  return (
    <Box component="article" aria-label={turn.question} data-state={turn.state} sx={{ display: 'grid', gap: 0.5 }}>
      <Typography fontWeight={600}>{turn.question}</Typography>
      <Typography
        data-testid="answer"
        sx={{ whiteSpace: 'pre-wrap', fontStyle: muted ? 'italic' : 'normal' }}
        color={turn.state === 'error' ? 'error' : muted ? 'text.secondary' : 'text.primary'}
      >
        {turn.answer}
        {turn.state === 'stopped' && ' (stopped)'}
      </Typography>
      {turn.sources.length > 0 && (
        <Stack direction="row" gap={0.5} flexWrap="wrap" aria-label="Sources">
          {turn.sources.map((s) => (
            <Tooltip key={s.n} title={s.excerpt}>
              <Chip size="small" variant="outlined" label={`[${s.n}] ${s.source} · ${s.relevance.toFixed(2)}`} />
            </Tooltip>
          ))}
        </Stack>
      )}
    </Box>
  );
}

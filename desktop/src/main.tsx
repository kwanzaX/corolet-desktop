import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { App } from './App';

// Follows the OS light/dark setting.
const theme = createTheme({
  colorSchemes: {
    light: { palette: { primary: { main: '#1f6f5c' }, background: { default: '#f3f4f1' } } },
    dark: { palette: { primary: { main: '#5fc1a8' }, background: { default: '#121615', paper: '#1a201e' } } },
  },
  shape: { borderRadius: 8 },
  typography: { fontFamily: '"Segoe UI", system-ui, sans-serif', button: { textTransform: 'none' } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={theme} defaultMode="system">
      <CssBaseline />
      <App />
    </ThemeProvider>
  </StrictMode>,
);

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/ui/App';
import '../../src/ui/styles.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><App workspace /></React.StrictMode>);

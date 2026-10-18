import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/ui/App';
import '../../src/ui/styles.css';
import '../../src/ui/refinement.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

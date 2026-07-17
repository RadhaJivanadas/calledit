import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { connect } from './ws.js';
import './styles.css';

connect();
createRoot(document.getElementById('root')).render(<App />);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { WalletProvider } from './wallet/WalletProvider';
import './styles/global.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <WalletProvider>
        <App />
      </WalletProvider>
    </BrowserRouter>
  </StrictMode>,
);

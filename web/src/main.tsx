import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { LiveProvider } from './lib/live';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Games } from './pages/Games';
import { Jobs } from './pages/Jobs';
import { Storage } from './pages/Storage';
import { SettingsPage } from './pages/Settings';

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: 1 } } });

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Games /> },
      { path: '/games', element: <Games /> },
      { path: '/overview', element: <Dashboard /> },
      { path: '/jobs', element: <Jobs /> },
      { path: '/jobs/:id', element: <Jobs /> },
      { path: '/storage', element: <Storage /> },
      { path: '/storage/:tab', element: <Storage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '/settings/:tab', element: <SettingsPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <LiveProvider>
        <RouterProvider router={router} />
      </LiveProvider>
    </QueryClientProvider>
  </StrictMode>,
);

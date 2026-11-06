import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/layout/AppLayout';
import { Button, Card, EmptyState } from './components/ui';
import { AgentDetails } from './pages/AgentDetails';
import { AttackDemo } from './pages/AttackDemo';
import { Dashboard } from './pages/Dashboard';
import { Documentation } from './pages/Documentation';
import { ExploreAgents } from './pages/ExploreAgents';
import { MyAgents } from './pages/MyAgents';
import { Reviews } from './pages/Reviews';
import { SubmitReview } from './pages/SubmitReview';
import { Link } from 'react-router-dom';

function NotFound() {
  return (
    <Card>
      <EmptyState
        title="Page not found"
        body="That route does not exist in Receipts."
        action={
          <Link to="/">
            <Button variant="primary" size="sm">
              Back to dashboard
            </Button>
          </Link>
        }
      />
    </Card>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="agents" element={<ExploreAgents />} />
        <Route path="agents/:agentId" element={<AgentDetails />} />
        <Route path="reviews" element={<Reviews />} />
        <Route path="my-agents" element={<MyAgents />} />
        <Route path="docs" element={<Documentation />} />
        <Route path="demo" element={<AttackDemo />} />
        <Route path="review/:agentId" element={<SubmitReview />} />
        {/* Kept so an older bookmark still lands somewhere sensible. */}
        <Route path="dashboard" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

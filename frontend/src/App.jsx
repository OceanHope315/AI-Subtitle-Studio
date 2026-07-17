import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import NewTaskPage from './pages/NewTaskPage'
import TasksPage from './pages/TasksPage'
import TaskWorkspace from './pages/TaskWorkspace'

function LegacyRedirect() {
  const location = useLocation()
  const taskId = new URLSearchParams(location.search).get('task')
  return <Navigate replace to={taskId ? `/tasks/${taskId}` : '/tasks'} />
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LegacyRedirect />} />
      <Route path="/tasks" element={<TasksPage />} />
      <Route path="/tasks/new" element={<NewTaskPage />} />
      <Route path="/tasks/:taskId" element={<TaskWorkspace />} />
      <Route path="*" element={<Navigate replace to="/tasks" />} />
    </Routes>
  )
}

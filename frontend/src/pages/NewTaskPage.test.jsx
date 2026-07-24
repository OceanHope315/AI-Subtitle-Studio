import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import NewTaskPage from './NewTaskPage'

const uploadVideo = vi.hoisted(() => vi.fn())

vi.mock('../api/tasks', () => ({
  uploadVideo,
}))

function renderPage() {
  const router = createMemoryRouter([
    { path: '/tasks/new', element: <NewTaskPage /> },
    { path: '/tasks/:taskId', element: <div>任务工作区</div> },
    { path: '/tasks', element: <div>任务中心</div> },
  ], { initialEntries: ['/tasks/new'] })
  const view = render(<RouterProvider router={router} />)
  return { ...view, router }
}

beforeEach(() => {
  uploadVideo.mockReset()
  uploadVideo.mockResolvedValue({ task: { taskId: 'task-one' } })
})

describe('NewTaskPage analysis mode', () => {
  it.each([
    ['默认选择', null, 'audio_visual'],
    ['纯音频选择', /纯音频模式/, 'audio'],
  ])('uploads using the %s', async (_label, modeName, expectedMode) => {
    const { container, router } = renderPage()
    if (modeName) fireEvent.click(screen.getByRole('radio', { name: modeName }))
    const file = new File(['video'], 'lesson.mp4', { type: 'video/mp4' })

    fireEvent.change(container.querySelector('input[type="file"]'), {
      target: { files: [file] },
    })

    await waitFor(() => expect(uploadVideo).toHaveBeenCalledWith(
      file,
      expect.any(Function),
      expectedMode,
    ))
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks/task-one'))
  })
})

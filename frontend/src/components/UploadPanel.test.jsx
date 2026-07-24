import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import UploadPanel from './UploadPanel'

describe('UploadPanel', () => {
  it('defaults to audio + visual and exposes an explicit audio-only choice', () => {
    const onAnalysisModeChange = vi.fn()
    render(
      <UploadPanel
        uploading={false}
        uploadProgress={0}
        error=""
        analysisMode="audio_visual"
        onAnalysisModeChange={onAnalysisModeChange}
        onUpload={vi.fn()}
      />,
    )

    expect(screen.getByRole('radio', { name: /音频 \+ 视觉模式/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /纯音频模式/ })).not.toBeChecked()

    fireEvent.click(screen.getByRole('radio', { name: /纯音频模式/ }))
    expect(onAnalysisModeChange).toHaveBeenCalledWith('audio')
  })

  it('accepts an MP4 dropped onto the upload zone', () => {
    const onUpload = vi.fn()
    render(<UploadPanel uploading={false} uploadProgress={0} error="" onUpload={onUpload} />)
    const file = new File(['video'], 'lesson.mp4', { type: 'video/mp4' })

    fireEvent.drop(screen.getByRole('button', { name: '上传 MP4 视频' }), {
      dataTransfer: { files: [file] },
    })

    expect(onUpload).toHaveBeenCalledWith(file)
  })

  it('rejects unsupported files before upload', () => {
    const onUpload = vi.fn()
    render(<UploadPanel uploading={false} uploadProgress={0} error="" onUpload={onUpload} />)
    const file = new File(['video'], 'lesson.avi', { type: 'video/x-msvideo' })

    fireEvent.drop(screen.getByRole('button', { name: '上传 MP4 视频' }), {
      dataTransfer: { files: [file] },
    })

    expect(onUpload).toHaveBeenCalledWith(null, expect.stringContaining('仅支持 MP4'))
  })

  it('shows upload progress', () => {
    render(
      <UploadPanel
        uploading
        uploadProgress={67}
        error=""
        analysisMode="audio"
        onUpload={vi.fn()}
      />,
    )
    expect(screen.getByText('67%')).toBeInTheDocument()
    expect(screen.getByText('正在安全上传视频')).toBeInTheDocument()
    expect(screen.getByText(/直接开始音频识别/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /纯音频模式/ })).toBeDisabled()
  })
})

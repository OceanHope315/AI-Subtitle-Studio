# AI Subtitle Studio Frontend

AI Subtitle Studio 的 React + Vite 前端。它覆盖完整的第一版工作流：上传 MP4、查看 AI 处理进度、播放视频、逐条校对字幕、时间轴定位、保存修改和导出 SRT。

## 环境要求

- Node.js 20 或更高版本
- 已启动的 Express 后端（默认地址 `http://localhost:3001`）

## 本地启动

```bash
npm ci
npm run dev
```

浏览器打开 `http://localhost:5173`。

如后端 API 不在默认地址，复制环境变量模板并调整：

```bash
copy .env.example .env.local
```

```env
VITE_API_BASE_URL=http://localhost:3001/api
```

`VITE_API_BASE_URL` 末尾是否带 `/` 均可，也支持反向代理后的相对地址（例如 `/api`）。

## 可用命令

```bash
npm run dev        # 开发服务器
npm run test       # 运行 Vitest 测试
npm run lint       # ESLint 静态检查
npm run build      # 生产构建
npm run preview    # 预览生产构建
```

## 对接接口

| 功能 | 方法与路径 | 数据约定 |
| --- | --- | --- |
| 上传视频 | `POST /api/tasks` | `multipart/form-data`，文件字段为 `video` |
| 查询进度 | `GET /api/tasks/:taskId` | 任务包含 `taskId`、`status`、`progress` |
| 读取字幕 | `GET /api/tasks/:taskId/subtitles` | `{ "subtitles": [...] }` |
| 保存字幕 | `PUT /api/tasks/:taskId/subtitles` | `{ "subtitles": [...] }` |
| 播放视频 | `GET /api/tasks/:taskId/video` | 支持浏览器视频播放与 Range 请求 |
| 导出 SRT | `GET /api/tasks/:taskId/export` | SRT 文件响应 |

任务状态支持 `queued`、`processing`、`completed`、`failed`。任务编号会写入 URL 的 `task` 查询参数，因此刷新页面后可以恢复当前任务。

## 编辑器行为

- 播放时自动高亮当前时间范围内的字幕。
- 点击字幕行或时间轴片段即可跳转。
- 时间输入支持纯秒数、`MM:SS.mmm` 和 `HH:MM:SS.mmm`。
- 导出前若有未保存修改，会先自动保存，确保导出的是最新版本。
- 离开存在未保存修改的页面前会触发浏览器保护提示。

## 目录

```text
src/
  api/          API 封装、错误处理与文件下载
  components/   上传、进度、播放器、字幕列表、时间轴等组件
  hooks/        任务进度轮询
  pages/        编辑器页面组合
  test/         测试环境配置
  utils/        字幕规范化、校验与时间格式工具
```

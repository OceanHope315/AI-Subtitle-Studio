# Security Policy

## Supported versions

项目处于 Alpha 阶段。安全修复仅应用到默认分支的最新版本。

## Reporting a vulnerability

请使用 GitHub 仓库的 **Security → Report a vulnerability** 私下报告安全问题。不要在公开
Issue 中披露漏洞、凭据、用户数据或可利用细节。

报告中请包含受影响版本、复现步骤、影响范围和可能的缓解方式。维护者会尽快确认收到，
并在修复或缓解措施可用后协调披露。

## Deployment scope

默认配置面向单用户本地开发，不包含用户认证、租户隔离或公网部署加固。不要将开发服务
直接暴露到不受信任网络；公网部署前应增加身份验证、TLS、反向代理、上传配额、持久化
存储备份和运行数据保留策略。

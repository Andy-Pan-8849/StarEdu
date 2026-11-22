# 项目根目录的总入口：一次性启动、停止、查看两个模块。
# Top-level shortcuts for running both modules together. Details: scripts/dev-all.sh and TRY-IT.md.
.PHONY: start-all stop-all status wire

start-all:  ## 准备配置、起容器、装演示数据、后台启动业务 API/网页和 AI 网页
	scripts/dev-all.sh start

stop-all:   ## 停后台进程和两边的容器（数据保留）
	scripts/dev-all.sh stop

status:     ## 看进程、端口和容器
	scripts/dev-all.sh status

wire:       ## 只补 .env：共享内部密钥、打开业务模式
	scripts/dev-all.sh wire

.PHONY: host-up host-down migrate seed dev

host-up:
	npm run host:up

host-down:
	npm run host:down

migrate:
	npm run host:migrate

seed:
	npm run host:seed

dev:
	npm run dev

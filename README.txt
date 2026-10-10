STRUTTURA Projects V1.04

Novinky:
- přihlášení e-mailem a heslem přes Supabase Auth
- zabezpečená cloudová synchronizace Mac ↔ mobil
- automatické načtení změn při otevření/fokusu + pravidelná kontrola
- lokální kopie dat zůstává jako offline pojistka
- ruční synchronizace a odhlášení v sekci Více
- vylepšená aktualizace service workeru, aby nové verze nezůstávaly v cache

Bezpečnost:
- v config.js je pouze publishable key určený pro frontend
- secret/service_role key ani databázové heslo nejsou součástí aplikace
- tabulka user_data musí mít zapnuté RLS a policy own data only

Před prvním vytvořením účtu v aplikaci nastav v Supabase Authentication -> URL Configuration:
Site URL: https://hh5fb92v4d-byte.github.io/struttura-projects/
Redirect URLs: https://hh5fb92v4d-byte.github.io/struttura-projects/**

STRUTTURA Projects V1.05

Oprava synchronizace:
- neodeslané lokální změny přežijí zavření aplikace
- starší cloudová verze nesmí přepsat novější lokální data
- pokud během synchronizace vznikne další změna, zápis se automaticky zopakuje
- po návratu internetu se nejdřív odešlou čekající lokální změny
- všechna data, zakázky, funkce a databázová struktura z V1.04 zůstávají beze změny

Důležité:
- aktualizace nemění tabulku user_data ani účet v Supabase
- před nahráním nové verze je přesto doporučený Export zálohy v sekci Více

Nasazení:
Nahraj obsah této složky do stejného GitHub repozitáře struttura-projects a přepiš stávající soubory. GitHub Pages zůstává beze změny.

STRUTTURA Projects V1.01

První funkční prototyp PWA aplikace pro evidenci realizací.

Obsah V1.01:
- Přehled: počet zakázek, obrat, náklady, zisk
- Zakázky: hledání podle klienta, města, materiálu a odstínu
- Nová zakázka / úprava zakázky
- Libovolný počet materiálů a barev u jedné zakázky
- Finance: cena, náklady, zisk, marže, cena za m²
- Detail zakázky
- Export/import zálohy dat
- Mobilní PWA rozhraní

Důležité:
V1.01 ukládá data lokálně v prohlížeči na konkrétním zařízení. Pro synchronizaci mezi telefonem a počítačem bude potřeba cloudová databáze v další verzi.

Lokální spuštění pro test:
1. Ve složce spusť jednoduchý webový server (např. python3 -m http.server 8080).
2. V prohlížeči otevři http://localhost:8080

Pro běžné používání na mobilu je potřeba aplikaci umístit na HTTPS hosting.

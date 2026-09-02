# PDF / PIXEL

PDF / PIXEL analysiert PDF-Seiten lokal und exportiert sie als detailgerechte,
verlustfrei komprimierte PNG-Dateien. Das Projekt enthält sowohl die Web-Version
als auch eine kleine Windows-App auf Basis von Tauri und der systemeigenen
WebView2-Laufzeit.

## Windows-App entwickeln

Voraussetzungen sind Node.js 22+, Rust (stable MSVC), Microsoft C++ Build Tools
mit **Desktop development with C++** und WebView2. Danach:

```powershell
npm install
npm run desktop:dev
```

## Windows-Installer bauen

```powershell
npm run desktop:build
```

Der NSIS-Installer wird unter
`src-tauri/target/release/bundle/nsis/` abgelegt.

Die App nutzt native Windows-Dateidialoge, liest PDFs ohne Upload, ermittelt
logische CPU-Kerne und physischen Arbeitsspeicher und schreibt PNG-/ZIP-Exporte
blockweise in eine temporäre Datei. Erst ein erfolgreicher Export ersetzt die
gewählte Zieldatei; ein Abbruch entfernt die temporäre Datei.

## Web-Version

```powershell
npm run dev
npm run build
```

English | [中文](README.md)

# Vocabulary-highlight — Your English Reading Assistant

> 中文名：词汇高亮（你的英语阅读助手）

A Manifest V3 Chrome extension that turns web reading into vocabulary learning: double-click any English word to highlight, translate, pronounce, and save it to your notebook — with inflection-aware highlighting, Ebbinghaus-based review, preset wordbooks, and sentence translation. All data stays local.

## Features

- **Double-click lookup + lemmatization** — double-click any English word on a page to reduce it to its lemma (`ate` → `eat`, `cats` → `cat`, `bigger` → `big`) and look it up instantly.
- **Inflection-aware highlighting** — saved words are highlighted across every page you visit, including all inflections (`eat/eats/ate/eaten/eating`), with hover-to-pronounce and hover-to-review.
- **Instant pronunciation** — auto-speak on save; pronunciation buttons in popups, the notebook, and the review page (Web Speech API).
- **Local dictionary first** — built-in mini dictionary → full ECDICT dictionary → preset wordbooks → custom MDX dictionaries → translation API fallback.
- **Preset wordbooks** — one-click import of CET-4/CET-6, IELTS, TOEFL, and more open-source word lists.
- **Custom MDX dictionaries** — import your own LDOCE5++ / OALD / COBUILD `.mdx` dictionaries with adjustable lookup priority.
- **Ebbinghaus review** — weighted random selection by "unknown count"; words you forget appear more often.
- **Sentence translation** — select an English sentence to translate it (default shortcut `Alt+T`), with optional saving.
- **Visual statistics** — sidebar totals plus a monthly and yearly calendar.
- **Local storage** — everything is stored in `chrome.storage.local` and IndexedDB; nothing is uploaded.

## Installation

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this project folder.
4. Click the toolbar icon to open the vocabulary notebook.

## Translation API Configuration

The extension prefers local dictionaries; the translation API is only called for words or sentences it cannot find locally. Supported providers: **Youdao, Baidu, Google, Caiyun, DeepSeek, OpenAI (GPT), and Google Gemini**. Choose a provider in **Settings**, fill in the credentials, save, then click **Test translation**.

### Youdao (default)
1. Go to [Youdao AI Cloud](https://ai.youdao.com/), create an app, and enable the **Text Translation** service.
2. Copy the **appKey** and **appSecret** into Settings.

### Baidu
1. Go to the [Baidu Translation Open Platform](https://fanyi-api.baidu.com/) and enable **General Text Translation**.
2. Copy the **appid** and **secret** into Settings.

### Google (Cloud Translation)
1. Go to the [Google Cloud Console](https://console.cloud.google.com/), create a project, and enable the **Cloud Translation API**.
2. Create an **API key** under *Credentials* and paste it into Settings.

### Caiyun (小译)
1. Go to the [Caiyun Open Platform](https://dashboard.caiyunapp.com/) and sign up.
2. Create an app to get a **Token**, then paste it into Settings.

### DeepSeek
1. Go to the [DeepSeek Platform](https://platform.deepseek.com/) and create an API key.
2. Paste it into Settings; the default model is `deepseek-chat` (configurable).

### OpenAI (GPT / any OpenAI-compatible endpoint)
1. Get an API key from the [OpenAI Platform](https://platform.openai.com/).
2. Paste it into Settings; the default model is `gpt-4o-mini` and the default endpoint is `https://api.openai.com/v1/chat/completions`. You can also set a custom `baseUrl` and model for other OpenAI-compatible services.

### Google Gemini
1. Get an API key from [Google AI Studio](https://aistudio.google.com/).
2. Paste it into Settings; the default model is `gemini-1.5-flash` (configurable).

> All credentials are stored locally in `chrome.storage.local` and are never uploaded.

## Dictionaries

- **Built-in mini dictionary** (`dict-builtin.js`): ~100 high-frequency words, offline and instant.
- **Full ECDICT dictionary**: click **Load full dictionary** in Settings to download and parse the ECDICT CSV (~66 MB) into IndexedDB.
- **Preset wordbooks**: import open-source word lists (CET-4/CET-6, IELTS, TOEFL, etc.) as separate books.
- **Custom MDX dictionaries**: import your own `.mdx` files (unencrypted, zlib/uncompressed MDict 2.0) with adjustable lookup priority.

Lookup order: built-in → full ECDICT → preset wordbooks → custom dictionaries → query cache → translation API.

## Project Structure

```
line_vocabulary/
├── manifest.json     # Manifest V3 (permissions, host_permissions, content scripts, icons)
├── background.js     # Service worker: dictionary lookup, API config, dictionary download/parse
├── lemmatizer.js     # Lightweight lemmatization and inflection generation
├── tts.js            # Text-to-speech (Web Speech API)
├── dict-builtin.js   # Built-in mini dictionary
├── dict-store.js     # IndexedDB wrapper (ECDICT, cache, preset, custom dictionaries)
├── mdx.js            # MDict (.mdx) parser
├── content.js        # Content script: double-click, lemmatize, highlight, sentence translation
├── content.css       # In-page highlight and popup styles
├── review.html       # Notebook / review / settings page
├── review.js         # Notebook / review / settings logic
├── review.css        # Notebook / review / settings styles
└── icons/            # Extension icons (16/48/128)
```

## Data Sources & Copyright

This extension does **not** bundle or distribute any dictionary or word-list data. All third-party data is downloaded or imported by the user; the extension only provides download links and parsing/storage.

| Data | Source | Notes |
| --- | --- | --- |
| ECDICT | [skywind3000/ECDICT](https://github.com/skywind3000/ECDICT) | Open-source EN-CN dictionary (MIT). |
| Preset word lists | [KyleBing/english-vocabulary](https://github.com/KyleBing/english-vocabulary), [leotse28/AGMess](https://github.com/leotse28/AGMess) | Open-source word lists. |
| Custom MDX | User-provided | The extension only parses `.mdx` files you supply. |
| Translation APIs | Youdao / Baidu / Google / Caiyun / DeepSeek / etc. | Credentials are user-provided and stored locally. |

## License

© 2026 [dooOoozen](https://github.com/dooOoozen). Licensed under the [Creative Commons Attribution-NonCommercial 4.0 International](https://creativecommons.org/licenses/by-nc/4.0/) (CC BY-NC 4.0) license.

You may freely modify and use this project, but **not for commercial purposes**; attribution to the author is required when using or redistributing it.

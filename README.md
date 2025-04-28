# PDF View Sync for Obsidian

This plugin automatically saves and restores the current page of PDF files viewed in Obsidian. When you close a PDF, the current page number is saved to the frontmatter of an associated Markdown note. When you reopen the PDF, the plugin retrieves this information and returns you to the same page.

## Features

- **Automatic State Saving:** When you close a PDF, the plugin automatically saves your current page position
- **Automatic State Loading:** When you open a PDF, the plugin automatically restores your previous page position
- **Customizable Note Association:** Configure how the plugin determines which note is associated with a PDF
- **Frontmatter Integration:** Data is stored in frontmatter, making it accessible to other plugins and queries

## Usage

1. Install the plugin
2. Configure the settings (optional - the defaults work well for most setups)
3. Open a PDF in Obsidian
4. When you close the PDF, your position will be saved
5. When you reopen the PDF, you'll be returned to the same page

No manual actions needed!

## Configuration

In the plugin settings, you can customize:

- **Associated Note Path Template:** Define how to find or create the Markdown note associated with each PDF. Supports placeholders:
  - `{{pdf_filename}}`: The full filename with extension (e.g., "Paper.pdf")
  - `{{pdf_basename}}`: The filename without extension (e.g., "Paper")
  - `{{pdf_folder_path}}`: The folder path containing the PDF
  - `{{pdf_parent_folder_name}}`: The name of the immediate parent folder
  
  Default: `@{{pdf_basename}}.md`

- **Frontmatter Key:** The key name used in the frontmatter to store PDF state.
  Default: `pdf-view-state`

- **Enable State Saving:** Master switch to enable/disable saving
  Default: Enabled

- **Enable State Loading:** Master switch to enable/disable loading
  Default: Enabled

- **Create Associated Note:** If enabled, creates the associated note when saving if it doesn't exist
  Default: Disabled

## Example

If you have a PDF file at `Research/Papers/Smith 2024.pdf` and your template is set to `@{{pdf_basename}}.md`, the plugin will look for a note at `Research/Papers/@Smith 2024.md`.

When you close the PDF after viewing page 15, the plugin will add or update:

```yaml
---
title: Some existing title
tags: [some, existing, tags]
pdf-view-state: 15
---

Your existing note content...
```

## Installation

### From Obsidian Community Plugins

1. Open Obsidian
2. Go to Settings → Community plugins
3. Click "Browse" and search for "PDF View Sync"
4. Click Install
5. Enable the plugin

### Manual Installation

1. Download the latest release
2. Extract the zip file into your Obsidian vault's `.obsidian/plugins/` directory
3. Enable the plugin in Obsidian's Community Plugins settings

## Development

If you want to contribute or modify this plugin:

1. Clone this repository
2. Run `npm i` to install dependencies
3. Run `npm run dev` to start development mode with hot reloading
4. Make your changes
5. Run `npm run build` to compile the plugin

## License

MIT License

## Support

If you encounter any issues or have feature requests, please file an issue in the [GitHub repository](https://github.com/callumalpass/obsidian-pdf-view-sync).
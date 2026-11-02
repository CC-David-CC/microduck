import {mountProjectApplication} from './web/project-application.ts';
import {getTrustedOpeningConfiguration} from './web/trusted-opening-config.ts';

const root = document.getElementById('project-inspection');
if (!root) throw new Error('Project inspection root is missing');

type DirectoryPickerWindow = Window & {showDirectoryPicker?: () => Promise<unknown>};
const pickerWindow = window as DirectoryPickerWindow;
if (typeof pickerWindow.showDirectoryPicker !== 'function') {
  const message = document.createElement('p');
  message.textContent = 'Folder selection is unavailable in this browser. Use Chrome or Chromium with folder access.';
  const button = document.createElement('button');
  button.type = 'button';
  button.disabled = true;
  button.textContent = 'Inspect project folder';
  root.append(message, button);
} else {
  mountProjectApplication({
    root,
    resolveTrusted: getTrustedOpeningConfiguration()?.resolveTrusted ?? null,
    // No await here: the picker is invoked directly by the inspector's click handler.
    chooseDirectory: () => pickerWindow.showDirectoryPicker!(),
    folderLimits: {max_files: 512, max_file_bytes: 16777216, max_total_bytes: 67108864, max_depth: 32, max_path_length: 240},
    inventoryLimits: {max_files: 512, max_file_bytes: 16777216, max_total_bytes: 67108864, max_manifest_bytes: 1048576, max_manifest_depth: 32},
  });
}

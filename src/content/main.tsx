import './styles/content.css';

import { bootstrapContentScript } from './runtime';

bootstrapContentScript();

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload();
  });
}

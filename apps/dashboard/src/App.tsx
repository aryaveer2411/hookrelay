import { useEffect, useState } from 'react';
import { getToken, onTokenChange, setToken } from './api';
import { EndpointPage } from './pages/EndpointPage';
import { EndpointsPage } from './pages/EndpointsPage';
import { EventPage } from './pages/EventPage';
import { Login } from './pages/Login';

// Tiny router: #/ → endpoints, #/endpoints/<id>, #/events/<id>
function useHashRoute() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return hash.replace(/^#/, '') || '/';
}

export default function App() {
  const [token, setTok] = useState(getToken());
  useEffect(() => onTokenChange(() => setTok(getToken())), []);
  const route = useHashRoute();

  if (!token) return <Login />;

  const ep = route.match(/^\/endpoints\/([0-9a-f-]{36})$/);
  const ev = route.match(/^\/events\/([0-9a-f-]{36})$/);
  const page = ep ? <EndpointPage key={ep[1]} id={ep[1]!} />
    : ev ? <EventPage key={ev[1]} id={ev[1]!} />
    : <EndpointsPage />;

  return (
    <div>
      <header>
        <a href="#/">HookRelay</a>
        <button onClick={() => setToken(null)}>Log out</button>
      </header>
      <main>{page}</main>
    </div>
  );
}

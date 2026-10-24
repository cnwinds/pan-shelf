import { Link, isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { Compass, TriangleAlert } from 'lucide-react';
import { Empty } from '../components/ui';

export function NotFound() {
  return (
    <div className="panel mt-6">
      <Empty icon={<Compass size={28} />} title="这个页面不存在">
        地址可能输错了，或者页面已经改名。
        <div className="mt-4">
          <Link to="/" className="btn btn-primary">回到游戏库</Link>
        </div>
      </Empty>
    </div>
  );
}

export function RouteError() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="panel mt-6">
      <Empty icon={<TriangleAlert size={28} />} title="页面出错了">
        <code className="break-all text-[12px]">{message}</code>
        <div className="mt-4 flex justify-center gap-2">
          <button className="btn" onClick={() => location.reload()}>刷新重试</button>
          <Link to="/" className="btn btn-primary">回到游戏库</Link>
        </div>
      </Empty>
    </div>
  );
}

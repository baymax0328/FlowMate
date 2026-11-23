import { createContext } from 'react';
export const DashboardTaskAction = createContext<(id:string)=>void>(()=>{});

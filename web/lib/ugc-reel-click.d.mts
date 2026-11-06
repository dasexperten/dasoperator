export function reelClickController(options: {open:()=>void;queue:()=>Promise<boolean>;delay?:number}): {click:(detail:number)=>void;dispose:()=>void};

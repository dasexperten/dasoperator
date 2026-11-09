type Failure={ok:false;http:404|409|422|503;code:string};
type View={id:string;creator_id:string;amount_minor:number;status:string;updated_at:number;payout_hold:boolean;
  review_snapshot:string;can_edit:boolean;saved_request:{request_id:string;expected_snapshot:string;amount_minor:number}|null};
export function readAmountReview(db:D1Database,id:string,requestId?:string|null):Promise<Failure|{ok:true;payout:View}>;
export function saveAmountReview(db:D1Database,input:{id:string;creator_id:string;expected_snapshot:string;
  amount_minor:number;request_id:string;actor_id:string;now:number}):Promise<Failure|{ok:true;replay:boolean;payout:View}>;

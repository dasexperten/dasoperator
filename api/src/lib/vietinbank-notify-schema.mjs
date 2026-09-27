// Exact NotifyRequest schema extracted from the official OAS; source hash below.
export default {
  "source": "https://openapi.vietinbank.vn/api/54418fc5-ee05-4683-8924-457d6ec8976f?product=03418e03-bb43-4c8c-bd11-be9e23fc8d20",
  "sourceSha256": "98203e1703b95a501a4906ac763f2a0da6f04ea05a3f6d621483e12990aa7d39",
  "NotifyRequest": {
    "type": "object",
    "required": [
      "msgId",
      "providerId",
      "transId",
      "transTime",
      "transType",
      "amount",
      "remark",
      "currencyCode",
      "signature"
    ],
    "properties": {
      "msgId": {
        "type": "string",
        "maxLength": 50,
        "description": "Mã định danh duy nhất của bản tin",
        "example": "MSG550e8400-e29b-41d4-a716"
      },
      "providerId": {
        "type": "string",
        "maxLength": 5,
        "description": "Mã nhà cung cấp do VietinBank cấp",
        "example": "VTB01"
      },
      "transId": {
        "type": "string",
        "maxLength": 50,
        "description": "Mã giao dịch duy nhất dùng để đối chiếu",
        "example": "FT23206000123456"
      },
      "transTime": {
        "type": "string",
        "maxLength": 14,
        "description": "Định dạng: yyyyMMddHHmmss",
        "example": "20201211155758"
      },
      "transType": {
        "type": "string",
        "maxLength": 20,
        "description": "Loại giao dịch (C: Credit, D: Debit, 1: Thông thường, 3: Tài khoản ảo...)",
        "enum": [
          "C",
          "D",
          "O",
          "1",
          "2",
          "COLLECTION",
          "3"
        ],
        "example": "C"
      },
      "custCode": {
        "type": "string",
        "maxLength": 30,
        "description": "Mã khách hàng/Mã thanh toán/Số danh bộ",
        "example": "VACVAV123456"
      },
      "sendBankId": {
        "type": "string",
        "maxLength": 6,
        "description": "Mã ngân hàng gửi (VietinBank: 970403)"
      },
      "sendBranchId": {
        "type": "string",
        "maxLength": 6,
        "description": "Mã chi nhánh gửi"
      },
      "sendAcctId": {
        "type": "string",
        "maxLength": 20,
        "description": "Số tài khoản gửi"
      },
      "sendAcctName": {
        "type": "string",
        "maxLength": 200,
        "description": "Tên tài khoản gửi"
      },
      "recvAcctId": {
        "type": "string",
        "maxLength": 20,
        "description": "Số tài khoản nhận"
      },
      "recvAcctName": {
        "type": "string",
        "maxLength": 20,
        "description": "Tên tài khoản nhận"
      },
      "recvVirtualAcctId": {
        "type": "string",
        "maxLength": 25,
        "description": "Tài khoản ảo/định danh nhận"
      },
      "recvVirtualAcctName": {
        "type": "string",
        "maxLength": 25,
        "description": "Tên tài khoản ảo nhận"
      },
      "amount": {
        "type": "string",
        "maxLength": 15,
        "description": "Số tiền giao dịch",
        "example": "100000"
      },
      "bankTransId": {
        "type": "string",
        "maxLength": 30,
        "description": "Số tham chiếu từ Bank (Số chứng từ)"
      },
      "remark": {
        "type": "string",
        "maxLength": 200,
        "description": "Nội dung giao dịch",
        "example": "THANH TOAN HOA DON 123"
      },
      "currencyCode": {
        "type": "string",
        "maxLength": 5,
        "description": "Mã tiền tệ (mặc định VND)",
        "default": "VND",
        "example": "VND"
      },
      "signature": {
        "type": "string",
        "maxLength": 4000,
        "description": "RSA SHA256. Chuỗi ký: transId + transTime + custCode + amount + bankTransId + remark (Bỏ qua trường rỗng)"
      }
    }
  }
};

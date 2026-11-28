# Bản cam kết sản phẩm cuối cùng và bộ metric đánh giá

**Đề tài:** Xây dựng nền tảng quản lý phòng Gym, hội viên và dịch vụ thể hình trực tuyến.

**Nhóm 02:** Bùi Nhật Dương — MSSV 23110198; Nguyễn Chí Cường — MSSV 23110188.

**Giảng viên hướng dẫn:** Lê Văn Vinh.

## 1 Mục tiêu và giá trị sử dụng

Xây dựng ứng dụng web giúp phòng Gym quản lý hội viên, gói tập, lịch huấn luyện, bán hàng và kho trên cùng hệ thống; giảm thời gian thao tác và sai lệch dữ liệu. Người sử dụng gồm quản trị viên, nhân viên, huấn luyện viên và hội viên.

## 2 Sản phẩm và phạm vi cam kết

| Nghiệp vụ | Chức năng cam kết |
| --- | --- |
| Tài khoản và bảo mật | Đăng ký, đăng nhập, đăng xuất, sửa hồ sơ, đổi và khôi phục mật khẩu; quản lý tài khoản và phân quyền. |
| Hội viên và gói dịch vụ | Tạo, liên kết, cập nhật, tra cứu hồ sơ hội viên; quản lý và tra cứu gói tập, gói huấn luyện cá nhân. |
| Đăng ký, gia hạn và nâng cấp gói | Thực hiện tại quầy và trực tuyến; hiển thị báo giá, thời hạn, số buổi còn lại và lịch sử sử dụng gói. |
| Thanh toán và chứng từ | Xác nhận thu tiền mặt hoặc chuyển khoản; lưu chứng từ, tra cứu giao dịch và ngăn ghi nhận thu trùng. |
| Lịch huấn luyện và lớp miễn phí | Quản lý huấn luyện viên, ca làm việc và lịch lớp; xem giờ trống, đặt hoặc hủy buổi tập; ngăn trùng lịch và vượt số buổi được phép. |
| Hoạt động và đánh giá huấn luyện viên | Chấm công, xác nhận buổi đã dạy, tra cứu học viên và gửi hoặc xem đánh giá. |
| Bán hàng và kho | Quản lý sản phẩm, tìm kiếm, giỏ hàng, đặt hàng trực tuyến và bán tại quầy; nhập, xuất, điều chỉnh tồn, chuẩn bị, bàn giao và hủy đơn. |
| Trả hàng và hoàn tiền | Tiếp nhận hàng trả, phân loại tình trạng hàng, cập nhật kho và theo dõi hoàn tiền theo chính sách. |
| Thông báo | Xem và đánh dấu đã đọc; gửi thông báo, nhắc hết hạn gói và lịch tập; hạn chế thông báo trùng. |
| Báo cáo quản trị | Thống kê hội viên, thu và hoàn tiền, hiệu suất huấn luyện viên; lọc theo kỳ và đối chiếu dữ liệu gốc. |

Đơn mua trực tuyến nhận tại quầy; thanh toán bằng tiền mặt hoặc chuyển khoản do nhân viên xác nhận. Phạm vi chưa bao gồm quét mã vào phòng, kế hoạch bài tập cá nhân, giao hàng tận nơi và cổng thanh toán tự động.

Sản phẩm bàn giao gồm ứng dụng chạy trực tuyến, mã nguồn, tài liệu hướng dẫn và minh chứng kiểm thử.

## 3 Chỉ số nghiệp vụ định lượng

| Nghiệp vụ | Mục tiêu | Cách đo |
| --- | --- | --- |
| Tra cứu hội viên | Đúng ít nhất 19/20 lượt; thời gian trung vị ≤ 30 giây. | Thực hiện 20 lượt tìm hồ sơ và xem quyền lợi; ghi thời gian, đối chiếu kết quả. |
| Đăng ký gói tại quầy | Thành công ít nhất 19/20 lượt; thời gian trung vị ≤ 3 phút. | Thử 20 lượt từ hồ sơ có sẵn đến xác nhận thu và cấp gói; kiểm tra chứng từ. |
| Đặt lịch huấn luyện | Thành công ít nhất 18/20 lượt hợp lệ; thời gian trung vị ≤ 60 giây. | Thử 20 lượt chọn huấn luyện viên, giờ tập và xác nhận lịch. |
| Bảo toàn lịch và số buổi | Không trùng lịch trái quy định, vượt số buổi hoặc ghi nhận hoàn tất lặp. | Thử tranh cùng giờ, buổi cuối và xử lý lặp; mỗi tình huống 10 vòng × 20 yêu cầu đồng thời. |
| Thu và hoàn tiền | Chênh lệch 0 đồng; không ghi nhận thu hoặc hoàn trùng. | Đối chiếu ít nhất 30 tình huống mua gói, mua hàng, hủy, trả và hoàn tiền với chứng từ. |
| Tồn kho | Không âm tồn; lượng giữ không vượt tồn thực; chênh lệch 0 sản phẩm. | Đối chiếu ít nhất 100 thao tác kho/bán hàng; thử tranh tồn cuối và gửi lặp, mỗi tình huống 10 vòng × 20 yêu cầu. |
| Nhắc gói và lịch tập | 100% mốc đủ điều kiện được nhắc đúng một lần; chậm ≤ 120 giây. | Thử 20 mốc: trước hết hạn gói 3/1 ngày và trước buổi tập 24/2 giờ, mỗi loại 5 mẫu; hàng chờ không quá 50 thông báo. |
| Báo cáo | 100% chỉ số được kiểm tra khớp dữ liệu gốc; tiền chênh 0 đồng. | Mỗi loại báo cáo thử ít nhất 5 trường hợp: có dữ liệu, rỗng, ranh giới ngày, cập nhật đồng thời và thiếu dữ liệu. |

Thời gian thao tác tính từ lúc bắt đầu đến khi nhận kết quả đúng. Dòng tiền bằng tiền thực thu trừ tiền thực hoàn trong kỳ. Hiệu suất huấn luyện viên dựa trên thời lượng buổi đã hoàn tất so với thời lượng ca hợp lệ; dữ liệu thiếu phải được thông báo.

## 4 Yêu cầu phi chức năng và chất lượng kỹ thuật

| Yêu cầu | Mục tiêu | Cách kiểm tra |
| --- | --- | --- |
| Bảo mật và phân quyền | 100% trường hợp thiếu quyền bị từ chối; không lộ dữ liệu của người khác. | Thử từng chức năng cần đăng nhập với sai vai trò, tài khoản khóa, phiên hết hạn và truy cập hồ sơ người khác. |
| Tốc độ phản hồi | Ít nhất 95% yêu cầu xem ≤ 1 giây, cập nhật ≤ 2 giây, báo cáo ≤ 3 giây; lỗi ngoài dự kiến < 1%. | Mô phỏng 50 người dùng đồng thời trong 10 phút, lặp 3 lần; từng lần phải đạt. |
| Giao diện | Các màn hình sử dụng được ở chiều rộng 360, 768 và 1366 điểm ảnh. | Kiểm tra theo từng vai trò; có trạng thái đang tải, không có dữ liệu, thành công và lỗi; không tràn ngang toàn trang. |
| An toàn dữ liệu | Không ghi dở dang hoặc nhân đôi tiền, tồn kho, số buổi khi lỗi hay gửi lại. | Gây lỗi giữa thao tác, ngắt kết nối và gửi lại; đối chiếu dữ liệu trước/sau. |
| Sao lưu và khôi phục | Ít nhất 1 lần khôi phục thành công; khôi phục và kiểm tra ≤ 30 phút. | Khôi phục vào môi trường riêng; đối chiếu hồ sơ, tiền, tồn kho và báo cáo. |
| Kiểm thử | Ít nhất 4 tầng kiểm thử; độ phủ dòng lệnh nghiệp vụ ≥ 70%; tự động hóa ≥ 70% ca kiểm thử; 100% ca bắt buộc đạt. | Lưu kết quả kiểm thử thành phần, tích hợp, giao tiếp và trình duyệt; báo cáo độ phủ tính cả mã chưa được kiểm thử. |

Đo hiệu năng và khôi phục với 1.000 hội viên, 100 sản phẩm, 5.000 giao dịch, 1.000 lịch tập; máy phục vụ tối thiểu 4 nhân xử lý, bộ nhớ 8 GB, máy phát tải riêng. Tải gồm 70% xem, 20% cập nhật, 10% báo cáo; khởi động ổn định 60 giây trước khi đo.

## 5 Metric hồ sơ và thực nghiệm theo rubric

| Tiêu chí rubric | Mục tiêu định lượng | Minh chứng |
| --- | --- | --- |
| Tính thực tiễn và hiểu biết vấn đề | Phỏng vấn ≥ 3 bên liên quan thực tế; so sánh ≥ 3 giải pháp hiện có; có ≥ 5 chỉ số nghiệp vụ. | Biên bản phỏng vấn và bảng so sánh có nguồn. |
| Phân tích nghiệp vụ và thiết kế | 100% chức năng cam kết có yêu cầu kiểm tra được; ≥ 4 loại sơ đồ; ≥ 5 yêu cầu phi chức năng định lượng; 5/5 điểm thiết kế kiểm tra khớp sản phẩm. | Đặc tả yêu cầu, sơ đồ và biên bản đối chiếu. |
| Hoàn thiện sản phẩm và khối lượng công việc | 100% chức năng cam kết hoạt động; có bản chạy trực tuyến; không có lỗi khi trình diễn. | Biên bản nghiệm thu theo mục 2, địa chỉ ứng dụng và kết quả trình diễn. |
| Làm chủ việc sử dụng AI | Ghi đầy đủ việc sử dụng AI; giải thích đúng 5/5 vị trí mã chọn ngẫu nhiên; minh chứng ≥ 3 lỗi AI đã phát hiện và sửa. | Nhật ký sử dụng AI, nội dung sửa và kết quả kiểm tra. |
| Chất lượng mã nguồn | Không còn lỗi quy tắc mã, lỗi nghiêm trọng hoặc khóa bí mật bị lộ; mã trùng lặp ≤ 5%. | Báo cáo phân tích mã nguồn và quét thông tin nhạy cảm. |
| Kiểm thử phần mềm | Đạt các ngưỡng kiểm thử tại mục 4; không còn lỗi nghiêm trọng. | Kế hoạch, kết quả kiểm thử, độ phủ và danh sách lỗi. |
| Triển khai và vận hành | Quy trình tự động có ≥ 4 chặng; ≥ 80% lần chạy thành công; ≥ 5 lần triển khai tự động; thời gian đưa bản mới lên môi trường thử nghiệm ≤ 30 phút. | Lịch sử chạy, triển khai và kiểm tra ứng dụng sau triển khai. |
| Thực nghiệm người dùng và cải tiến | ≥ 10 người dùng thực; mỗi người ≥ 3 tác vụ; tỷ lệ hoàn thành ≥ 90%; điểm SUS trung bình ≥ 80/100; ≥ 1 vòng cải tiến có đo lại. | Danh sách ẩn danh, kết quả tác vụ, bảng hỏi SUS 10 câu và so sánh trước/sau. |
| Thuyết trình | Trình diễn trực tiếp không lỗi; sai lệch thời gian ≤ 10% so với quy định. | Kết quả diễn tập và biên bản trình bày. |
| Báo cáo và tài liệu tham khảo | Vận dụng ≥ 3 tài liệu ngoại ngữ; trùng lặp ≤ 25% ngoài trích dẫn hợp lệ; ≤ 5 lỗi chính tả/định dạng; ≥ 90% hình và bảng được đánh số, dẫn chiếu. | Báo cáo, danh mục tham khảo và kết quả rà soát. |
| Trả lời câu hỏi | Đúng trọng tâm ≥ 80% câu hỏi; chính xác ≥ 75% câu hỏi kỹ thuật. | Biên bản ghi câu hỏi và kết quả trả lời. |

Người tham gia thực nghiệm thuộc nhóm quản lý, nhân viên, huấn luyện viên và hội viên. Tỷ lệ hoàn thành tính trên toàn bộ tác vụ đã giao, kể cả lượt bỏ cuộc hoặc hết giờ. Lỗi nghiêm trọng gồm lộ dữ liệu, sai tiền, sai tồn, sai số buổi hoặc không thực hiện được chức năng chính.


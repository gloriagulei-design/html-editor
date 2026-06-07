# HTML可视化编辑器 - 生产环境
# 使用Nginx提供静态文件服务

FROM nginx:stable-alpine

# 设置工作目录
WORKDIR /usr/share/nginx/html

# 删除默认页面
RUN rm -f /usr/share/nginx/html/index.html

# 复制所有静态资源
COPY . /usr/share/nginx/html

# 自定义Nginx配置：启用gzip压缩和缓存
RUN echo 'server { \
    listen 8000; \
    server_name localhost; \
    root /usr/share/nginx/html; \
    index index.html; \
    \
    location / { \
        try_files $uri $uri/ /index.html; \
    } \
    \
    gzip on; \
    gzip_types text/plain text/css application/javascript application/json text/xml application/xml; \
    gzip_min_length 1024; \
    \
    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ { \
        expires 30d; \
        add_header Cache-Control "public, immutable"; \
    } \
}' > /etc/nginx/conf.d/default.conf

# 暴露端口
EXPOSE 8000

# 运行Nginx
CMD ["nginx", "-g", "daemon off;"]

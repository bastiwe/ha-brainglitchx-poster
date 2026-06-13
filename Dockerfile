ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apk add --no-cache nodejs npm python3 make g++ jq

WORKDIR /app
COPY app/package.json ./
RUN npm install --omit=dev
COPY app ./
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD ["/run.sh"]
